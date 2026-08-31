import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { campaigns, conversations, media, messages, tenantSettings } from './schema.ts'
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
            title: c.title,
            isGroup: c.isGroup ? 1 : 0,
            leadSourceCode: c.leadSourceCode ?? null,
            leadSourceVia: c.leadSourceVia ?? null,
            lastMessageAt: c.lastMessageAt,
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: [conversations.tenant, conversations.id],
            set: {
              contactId: sql`COALESCE(excluded.contact_id, ${conversations.contactId})`,
              title: sql`excluded.title`,
              isGroup: sql`excluded.is_group`,
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
          .values(mapInsert(tenant, m))
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
              mediaId: sql`COALESCE(${m.mediaId ?? null}, ${messages.mediaId})`
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

  listMessages(tenant: string, conversationId: string, limit = 500): StoredMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenant, tenant), eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.timestamp))
      .limit(limit)
      .all()
      .map(toMessage)
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

  hasMedia(tenant: string, mediaId: string): boolean {
    return !!this.db
      .select({ x: sql`1` })
      .from(media)
      .where(and(eq(media.tenant, tenant), eq(media.mediaId, mediaId)))
      .get()
  }
}

type ConvRow = typeof conversations.$inferSelect
type MsgRow = typeof messages.$inferSelect

function mapInsert(tenant: string, m: SyncMessage): typeof messages.$inferInsert {
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
    timestamp: m.timestamp
  }
}

function toConversation(r: ConvRow): SyncConversation {
  return {
    id: r.id,
    channel: r.channel,
    accountId: r.accountId,
    contactId: r.contactId ?? undefined,
    title: r.title,
    isGroup: r.isGroup === 1,
    leadSourceCode: r.leadSourceCode ?? undefined,
    leadSourceVia: r.leadSourceVia ?? undefined,
    lastMessageAt: r.lastMessageAt
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
    timestamp: r.timestamp
  }
}
