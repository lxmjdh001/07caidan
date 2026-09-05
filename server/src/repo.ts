import { and, asc, desc, eq, gt, inArray, like, or, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { campaigns, conversationReads, conversations, media, messages, syncClaims, tenantSettings } from './schema.ts'
import type { StoredMessage, SyncConversation, SyncMessage, SyncPayload } from './types.ts'

/** 数据访问层（Drizzle）。幂等 upsert + 查询，全部按 tenant 隔离。 */
export class Repo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  getTenantSetting(tenant: string, key: string): string | undefined {
    return this.db.select({ value: tenantSettings.value }).from(tenantSettings)
      .where(and(eq(tenantSettings.tenant, tenant), eq(tenantSettings.key, key))).get()?.value
  }

  setTenantSetting(tenant: string, key: string, value: string): void {
    this.db.insert(tenantSettings).values({ tenant, key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: [tenantSettings.tenant, tenantSettings.key], set: { value, updatedAt: Date.now() } }).run()
  }

  /** 批量写入一次同步 payload，返回真正新写入的消息条数（去重后） */
  ingest(tenant: string, payload: SyncPayload): { conversations: number; messages: number } {
    const now = Date.now()
    let msgCount = 0

    this.db.transaction((tx) => {
      for (const c of payload.conversations) {
        tx.insert(conversations)
          .values({
            tenant,
            id: c.id,
            channel: c.channel,
            accountId: c.accountId,
            contactId: c.contactId ?? null,
            publicId: c.publicId ?? null,
            avatarMediaId: c.avatarMediaId ?? null,
            title: c.title,
            isGroup: c.isGroup ? 1 : 0,
            detectedLang: c.detectedLang ?? null,
            langOverride: c.langOverride ?? null,
            autoReply: c.autoReply ? 1 : 0,
            pinned: c.pinned ? 1 : 0,
            muted: c.muted ? 1 : 0,
            customerNote: c.customerNote ?? '',
            lastMessagePreview: c.lastMessagePreview ?? '',
            leadSourceCode: c.leadSourceCode ?? null,
            leadSourceVia: c.leadSourceVia ?? null,
            lastMessageAt: c.lastMessageAt,
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: [conversations.tenant, conversations.id],
            set: {
              contactId: sql`COALESCE(excluded.contact_id, ${conversations.contactId})`,
              publicId: sql`COALESCE(excluded.public_id, ${conversations.publicId})`,
              avatarMediaId: sql`COALESCE(excluded.avatar_media_id, ${conversations.avatarMediaId})`,
              title: sql`excluded.title`,
              isGroup: sql`excluded.is_group`,
              detectedLang: sql`COALESCE(excluded.detected_lang, ${conversations.detectedLang})`,
              // langOverride 的 null 有“清除”语义，因此跟随本次客户端快照。
              langOverride: c.langOverride === undefined ? conversations.langOverride : sql`excluded.lang_override`,
              autoReply: c.autoReply === undefined ? conversations.autoReply : sql`excluded.auto_reply`,
              pinned: c.pinned === undefined ? conversations.pinned : sql`excluded.pinned`,
              muted: c.muted === undefined ? conversations.muted : sql`excluded.muted`,
              customerNote: c.customerNote === undefined ? conversations.customerNote : sql`excluded.customer_note`,
              lastMessagePreview: c.lastMessagePreview === undefined
                ? conversations.lastMessagePreview
                : sql`excluded.last_message_preview`,
              // 来源只认第一次，后续同步不覆盖（客户端也是这个口径）
              leadSourceCode: sql`COALESCE(${conversations.leadSourceCode}, excluded.lead_source_code)`,
              leadSourceVia: sql`COALESCE(${conversations.leadSourceVia}, excluded.lead_source_via)`,
              lastMessageAt: sql`MAX(excluded.last_message_at, ${conversations.lastMessageAt})`,
              updatedAt: sql`excluded.updated_at`
            }
          })
          .run()
      }

      // 账号资料由客户端连接实时上报。工单保存的是展示快照，这里把最新资料
      // 回写到所有包含该账号的工单，避免头像/在线状态只在创建工单时固定一次。
      if (payload.accountProfiles && payload.accountProfiles.length > 0) {
        const campaignRows = tx.select().from(campaigns).where(eq(campaigns.tenant, tenant)).all()
        for (const campaign of campaignRows) {
          let accountIds: string[]
          let profiles: Record<string, Record<string, unknown>>
          try {
            accountIds = JSON.parse(campaign.accountIds) as string[]
            profiles = JSON.parse(campaign.accountProfiles) as Record<string, Record<string, unknown>>
          } catch {
            continue
          }
          if (!Array.isArray(accountIds) || !profiles || typeof profiles !== 'object') continue
          let changed = false
          for (const incoming of payload.accountProfiles) {
            if (!accountIds.includes(incoming.accountId)) continue
            const previous = profiles[incoming.accountId] ?? {}
            const next: Record<string, unknown> = {
              ...previous,
              channel: incoming.channel,
              ...(incoming.handle !== undefined ? { handle: incoming.handle } : {}),
              ...(incoming.status !== undefined ? { status: incoming.status } : {}),
              ...(incoming.avatarMediaId ? { avatarMediaId: incoming.avatarMediaId } : {})
            }
            if (JSON.stringify(previous) !== JSON.stringify(next)) {
              profiles[incoming.accountId] = next
              changed = true
            }
          }
          if (changed) {
            tx.update(campaigns)
              .set({ accountProfiles: JSON.stringify(profiles), updatedAt: Date.now() })
              .where(and(eq(campaigns.tenant, tenant), eq(campaigns.id, campaign.id)))
              .run()
          }
        }
      }

      for (const m of payload.messages) {
        const res = tx
          .insert(messages)
          .values(mapInsert(tenant, m, now))
          .onConflictDoNothing({ target: [messages.tenant, messages.externalId] })
          .run()
        if (res.changes > 0) {
          msgCount++
        } else {
          // 已存在 → 补充译文/媒体（不覆盖为 null）
          tx.update(messages)
            .set({
              translationText: sql`COALESCE(${m.translationText ?? null}, ${messages.translationText})`,
              translationLang: sql`COALESCE(${m.translationLang ?? null}, ${messages.translationLang})`,
              mediaId: sql`COALESCE(${m.mediaId ?? null}, ${messages.mediaId})`,
              updatedAt: now
            })
            .where(and(eq(messages.tenant, tenant), eq(messages.externalId, m.externalId)))
            .run()
        }
      }
    })

    return { conversations: payload.conversations.length, messages: msgCount }
  }

  listConversations(tenant: string, limit = 100, offset = 0): SyncConversation[] {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.tenant, tenant))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(toConversation)
  }

  pullConversations(tenant: string, updatedAt: number, id: string, limit = 500): SyncConversation[] {
    return this.db.select().from(conversations).where(and(
      eq(conversations.tenant, tenant),
      or(
        gt(conversations.updatedAt, updatedAt),
        and(eq(conversations.updatedAt, updatedAt), gt(conversations.id, id))
      )
    )).orderBy(asc(conversations.updatedAt), asc(conversations.id)).limit(limit).all().map(toConversation)
  }

  listMessages(tenant: string, conversationId: string, limit = 500, offset = 0): StoredMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenant, tenant), eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.timestamp))
      .limit(limit)
      .offset(offset)
      .all()
      .map(toMessage)
  }

  /**
   * 给桌面端的增量消息流。游标使用 (updated_at, external_id) 复合键，避免同一毫秒
   * 的大批量同步在分页边界丢消息。
   */
  pullMessages(tenant: string, updatedAt: number, externalId: string, limit = 500): StoredMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.tenant, tenant),
          or(
            gt(messages.updatedAt, updatedAt),
            and(eq(messages.updatedAt, updatedAt), gt(messages.externalId, externalId))
          )
        )
      )
      .orderBy(asc(messages.updatedAt), asc(messages.externalId))
      .limit(limit)
      .all()
      .map(toMessage)
  }

  conversationsForMessages(tenant: string, messagesToMap: readonly StoredMessage[]): SyncConversation[] {
    const ids = [...new Set(messagesToMap.map((m) => m.conversationId))]
    if (ids.length === 0) return []
    return this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenant, tenant), inArray(conversations.id, ids)))
      .all()
      .map(toConversation)
  }

  /** 按客户标识跨会话/账号取全部消息（供 AI 分析该客户意向） */
  messagesByContact(tenant: string, contactId: string): StoredMessage[] {
    return this.db
      .select({ m: messages })
      .from(messages)
      .innerJoin(
        conversations,
        and(eq(conversations.tenant, messages.tenant), eq(conversations.id, messages.conversationId))
      )
      .where(and(eq(messages.tenant, tenant), eq(conversations.contactId, contactId)))
      .orderBy(asc(messages.timestamp))
      .all()
      .map((r) => toMessage(r.m))
  }

  recordMedia(tenant: string, mediaId: string, mime: string | null, path: string, size: number): void {
    this.db
      .insert(media)
      .values({ tenant, mediaId, mimeType: mime, path, size })
      .onConflictDoUpdate({
        target: [media.tenant, media.mediaId],
        set: { path: sql`excluded.path`, size: sql`excluded.size` }
      })
      .run()
  }

  getMedia(tenant: string, mediaId: string): { path: string; mimeType: string | null } | null {
    const r = this.db
      .select()
      .from(media)
      .where(and(eq(media.tenant, tenant), eq(media.mediaId, mediaId)))
      .get()
    return r ? { path: r.path, mimeType: r.mimeType } : null
  }

  /** 管理员查看支持工单附件时，可在其租户下的客户工作区中按不可猜 mediaId 查找。 */
  getMediaForAdmin(tenant: string, mediaId: string): { path: string; mimeType: string | null } | null {
    const r = this.db
      .select()
      .from(media)
      .where(and(or(eq(media.tenant, tenant), like(media.tenant, `${tenant}::workspace:%`)), eq(media.mediaId, mediaId)))
      .get()
    return r ? { path: r.path, mimeType: r.mimeType } : null
  }

  hasMedia(tenant: string, mediaId: string): boolean {
    return !!this.db
      .select({ x: sql`1` })
      .from(media)
      .where(and(eq(media.tenant, tenant), eq(media.mediaId, mediaId)))
      .get()
  }


  markRead(tenant: string, userId: number, conversationId: string): { readAt: number; updatedAt: number } {
    const now = Date.now()
    this.db.insert(conversationReads)
      .values({ tenant, userId, conversationId, readAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [conversationReads.tenant, conversationReads.userId, conversationReads.conversationId],
        set: { readAt: now, updatedAt: now }
      }).run()
    return { readAt: now, updatedAt: now }
  }

  pullReads(tenant: string, userId: number, updatedAt: number, conversationId: string, limit = 500): Array<{
    conversationId: string; readAt: number; updatedAt: number
  }> {
    return this.db.select({
      conversationId: conversationReads.conversationId,
      readAt: conversationReads.readAt,
      updatedAt: conversationReads.updatedAt
    }).from(conversationReads).where(and(
      eq(conversationReads.tenant, tenant),
      eq(conversationReads.userId, userId),
      or(
        gt(conversationReads.updatedAt, updatedAt),
        and(eq(conversationReads.updatedAt, updatedAt), gt(conversationReads.conversationId, conversationId))
      )
    )).orderBy(asc(conversationReads.updatedAt), asc(conversationReads.conversationId)).limit(limit).all()
  }

  /** 返回 true 仅表示当前工作区第一次成功占位。 */
  claim(tenant: string, purpose: string, claimKey: string): boolean {
    const result = this.db.insert(syncClaims)
      .values({ tenant, purpose, claimKey, createdAt: Date.now() })
      .onConflictDoNothing({ target: [syncClaims.tenant, syncClaims.purpose, syncClaims.claimKey] })
      .run()
    return result.changes > 0
  }
}

type ConvRow = typeof conversations.$inferSelect
type MsgRow = typeof messages.$inferSelect

function mapInsert(tenant: string, m: SyncMessage, updatedAt: number): typeof messages.$inferInsert {
  return {
    tenant,
    externalId: m.externalId,
    conversationId: m.conversationId,
    channel: m.channel,
    accountId: m.accountId,
    direction: m.direction,
    authorName: m.authorName ?? null,
    bodyType: m.bodyType,
    text: m.text ?? null,
    mediaType: m.mediaType ?? null,
    mediaId: m.mediaId ?? null,
    mimeType: m.mimeType ?? null,
    fileName: m.fileName ?? null,
    caption: m.caption ?? null,
    durationSec: m.durationSec ?? null,
    translationText: m.translationText ?? null,
    translationLang: m.translationLang ?? null,
    timestamp: m.timestamp,
    updatedAt
  }
}

function toConversation(r: ConvRow): SyncConversation {
  return {
    id: r.id,
    channel: r.channel,
    accountId: r.accountId,
    contactId: r.contactId ?? undefined,
    publicId: r.publicId ?? undefined,
    avatarMediaId: r.avatarMediaId ?? undefined,
    title: r.title,
    isGroup: r.isGroup === 1,
    detectedLang: r.detectedLang ?? undefined,
    langOverride: r.langOverride ?? undefined,
    autoReply: r.autoReply === 1,
    pinned: r.pinned === 1,
    muted: r.muted === 1,
    customerNote: r.customerNote,
    lastMessagePreview: r.lastMessagePreview,
    leadSourceCode: r.leadSourceCode ?? undefined,
    leadSourceVia: r.leadSourceVia ?? undefined,
    lastMessageAt: r.lastMessageAt,
    syncUpdatedAt: r.updatedAt
  }
}

function toMessage(r: MsgRow): StoredMessage {
  return {
    externalId: r.externalId,
    conversationId: r.conversationId,
    channel: r.channel,
    accountId: r.accountId,
    direction: r.direction === 'out' ? 'out' : 'in',
    authorName: r.authorName ?? undefined,
    bodyType: r.bodyType as SyncMessage['bodyType'],
    text: r.text ?? undefined,
    mediaType: r.mediaType ?? undefined,
    mediaId: r.mediaId ?? undefined,
    mimeType: r.mimeType ?? undefined,
    fileName: r.fileName ?? undefined,
    caption: r.caption ?? undefined,
    durationSec: r.durationSec ?? undefined,
    translationText: r.translationText ?? undefined,
    translationLang: r.translationLang ?? undefined,
    timestamp: r.timestamp,
    syncUpdatedAt: r.updatedAt
  }
}
