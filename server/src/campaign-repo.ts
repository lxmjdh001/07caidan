import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, isNotNull, lte, min, sql } from 'drizzle-orm'
import {
  computeCampaignStats,
  fillDays,
  type CampaignStats,
  type LeadRow
} from './campaign-stats.ts'
import type { LibraryChannel } from './contact-id.ts'
import type { Db } from './db.ts'
import {
  campaignLinks,
  campaigns,
  conversations,
  fanLibraries,
  fanLibraryEntries,
  messages
, entryLinks } from './schema.ts'

/** SQLite 单条语句的变量上限较保守，大名单分批处理 */
const CHUNK = 400

export interface Campaign {
  id: string
  name: string
  accountIds: string[]
  accountLabels: Record<string, string>
  startAt: number
  endAt?: number
  dedupLibraryIds: string[]
  dedupBeforeAt?: number
  /** 时间规则的统计范围；空 = 全部账号 */
  dedupAccountIds: string[]
  /** 只统计这些投放来源码；空 = 全部来源 */
  sourceCodes: string[]
  tzOffsetMinutes: number
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export interface EntryLinkRow {
  tenant: string
  id: string
  name: string
  channel: string
  accountId: string
  handle: string
  code: string
  greeting: string
  createdAt: number
}

export interface CampaignLink {
  token: string
  campaignId: string
  label?: string
  expiresAt?: number
  revoked: boolean
  createdAt: number
  /** 派生状态，前端直接展示 */
  active: boolean
}

export interface FanLibrary {
  id: string
  name: string
  channel: string
  source: string
  entryCount: number
  createdAt: number
}

export interface CampaignInput {
  name: string
  accountIds: string[]
  accountLabels?: Record<string, string>
  startAt: number
  endAt?: number
  dedupLibraryIds?: string[]
  dedupBeforeAt?: number
  dedupAccountIds?: string[]
  sourceCodes?: string[]
  tzOffsetMinutes?: number
}

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 工单 / 分享链接 / 重粉库的数据访问层 */
export class CampaignRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // ── 工单 ──

  createCampaign(tenant: string, input: CampaignInput, createdBy?: string): Campaign {
    const now = Date.now()
    const row = {
      tenant,
      id: randomUUID(),
      name: input.name,
      accountIds: JSON.stringify(input.accountIds),
      accountLabels: JSON.stringify(input.accountLabels ?? {}),
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      dedupLibraryIds: JSON.stringify(input.dedupLibraryIds ?? []),
      dedupBeforeAt: input.dedupBeforeAt ?? null,
      dedupAccountIds: JSON.stringify(input.dedupAccountIds ?? []),
      sourceCodes: JSON.stringify(input.sourceCodes ?? []),
      tzOffsetMinutes: input.tzOffsetMinutes ?? 480,
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now
    }
    this.db.insert(campaigns).values(row).run()
    return toCampaign(row as typeof campaigns.$inferSelect)
  }

  listCampaigns(tenant: string): Campaign[] {
    return this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.tenant, tenant))
      .orderBy(sql`${campaigns.createdAt} DESC`)
      .all()
      .map(toCampaign)
  }

  getCampaign(tenant: string, id: string): Campaign | null {
    const r = this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.tenant, tenant), eq(campaigns.id, id)))
      .get()
    return r ? toCampaign(r) : null
  }

  updateCampaign(tenant: string, id: string, patch: Partial<CampaignInput>): boolean {
    const set: Record<string, unknown> = { updatedAt: Date.now() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.accountIds !== undefined) set.accountIds = JSON.stringify(patch.accountIds)
    if (patch.accountLabels !== undefined) {
      set.accountLabels = JSON.stringify(patch.accountLabels)
    }
    if (patch.startAt !== undefined) set.startAt = patch.startAt
    if (patch.endAt !== undefined) set.endAt = patch.endAt
    if (patch.dedupLibraryIds !== undefined) {
      set.dedupLibraryIds = JSON.stringify(patch.dedupLibraryIds)
    }
    if (patch.dedupBeforeAt !== undefined) set.dedupBeforeAt = patch.dedupBeforeAt
    if (patch.dedupAccountIds !== undefined) {
      set.dedupAccountIds = JSON.stringify(patch.dedupAccountIds)
    }
    if (patch.sourceCodes !== undefined) set.sourceCodes = JSON.stringify(patch.sourceCodes)
    if (patch.tzOffsetMinutes !== undefined) set.tzOffsetMinutes = patch.tzOffsetMinutes
    const res = this.db
      .update(campaigns)
      .set(set)
      .where(and(eq(campaigns.tenant, tenant), eq(campaigns.id, id)))
      .run()
    return res.changes > 0
  }

  deleteCampaign(tenant: string, id: string): boolean {
    return this.db.transaction((tx) => {
      tx.delete(campaignLinks)
        .where(and(eq(campaignLinks.tenant, tenant), eq(campaignLinks.campaignId, id)))
        .run()
      const res = tx
        .delete(campaigns)
        .where(and(eq(campaigns.tenant, tenant), eq(campaigns.id, id)))
        .run()
      return res.changes > 0
    })
  }

  // ── 分享链接 ──

  createLink(
    tenant: string,
    campaignId: string,
    opts: { label?: string; expiresAt?: number } = {}
  ): CampaignLink {
    const row = {
      token: randomBytes(16).toString('hex'),
      tenant,
      campaignId,
      label: opts.label ?? null,
      expiresAt: opts.expiresAt ?? null,
      revoked: 0,
      createdAt: Date.now()
    }
    this.db.insert(campaignLinks).values(row).run()
    return toLink(row as typeof campaignLinks.$inferSelect)
  }

  listLinks(tenant: string, campaignId: string): CampaignLink[] {
    return this.db
      .select()
      .from(campaignLinks)
      .where(and(eq(campaignLinks.tenant, tenant), eq(campaignLinks.campaignId, campaignId)))
      .orderBy(sql`${campaignLinks.createdAt} DESC`)
      .all()
      .map(toLink)
  }

  /** 手动失效，立即生效 */
  revokeLink(tenant: string, token: string): boolean {
    const res = this.db
      .update(campaignLinks)
      .set({ revoked: 1 })
      .where(and(eq(campaignLinks.tenant, tenant), eq(campaignLinks.token, token)))
      .run()
    return res.changes > 0
  }

  deleteLink(tenant: string, token: string): boolean {
    const res = this.db
      .delete(campaignLinks)
      .where(and(eq(campaignLinks.tenant, tenant), eq(campaignLinks.token, token)))
      .run()
    return res.changes > 0
  }

  /**
   * 公开访问入口：用分享令牌换工单。
   * 失效原因要分开返回 —— 前端给访问者的提示不一样（过期 vs 被撤销 vs 链接不存在）。
   */
  resolveLink(
    token: string,
    now = Date.now()
  ): { ok: true; tenant: string; campaign: Campaign } | { ok: false; reason: string } {
    const link = this.db.select().from(campaignLinks).where(eq(campaignLinks.token, token)).get()
    if (!link) return { ok: false, reason: 'not_found' }
    if (link.revoked === 1) return { ok: false, reason: 'revoked' }
    if (link.expiresAt !== null && link.expiresAt <= now) return { ok: false, reason: 'expired' }
    const campaign = this.getCampaign(link.tenant, link.campaignId)
    if (!campaign) return { ok: false, reason: 'not_found' }
    return { ok: true, tenant: link.tenant, campaign }
  }

  // ── 重粉库 ──

  createLibrary(
    tenant: string,
    name: string,
    channel: LibraryChannel,
    source: 'export' | 'import'
  ): FanLibrary {
    const row = {
      tenant,
      id: randomUUID(),
      name,
      channel,
      source,
      entryCount: 0,
      createdAt: Date.now()
    }
    this.db.insert(fanLibraries).values(row).run()
    return toLibrary(row as typeof fanLibraries.$inferSelect)
  }

  listLibraries(tenant: string): FanLibrary[] {
    return this.db
      .select()
      .from(fanLibraries)
      .where(eq(fanLibraries.tenant, tenant))
      .orderBy(sql`${fanLibraries.createdAt} DESC`)
      .all()
      .map(toLibrary)
  }

  getLibrary(tenant: string, id: string): FanLibrary | null {
    const r = this.db
      .select()
      .from(fanLibraries)
      .where(and(eq(fanLibraries.tenant, tenant), eq(fanLibraries.id, id)))
      .get()
    return r ? toLibrary(r) : null
  }

  deleteLibrary(tenant: string, id: string): boolean {
    return this.db.transaction((tx) => {
      tx.delete(fanLibraryEntries)
        .where(and(eq(fanLibraryEntries.tenant, tenant), eq(fanLibraryEntries.libraryId, id)))
        .run()
      const res = tx
        .delete(fanLibraries)
        .where(and(eq(fanLibraries.tenant, tenant), eq(fanLibraries.id, id)))
        .run()
      return res.changes > 0
    })
  }

  /** 往库里加标识；返回真正新增的条数（已存在的不重复计） */
  addEntries(tenant: string, libraryId: string, contactIds: string[]): number {
    if (contactIds.length === 0) return 0
    const now = Date.now()
    let added = 0
    this.db.transaction((tx) => {
      for (const batch of chunked(contactIds)) {
        for (const contactId of batch) {
          const res = tx
            .insert(fanLibraryEntries)
            .values({ tenant, libraryId, contactId, addedAt: now })
            .onConflictDoNothing()
            .run()
          added += res.changes
        }
      }
      tx.update(fanLibraries)
        .set({ entryCount: sql`${fanLibraries.entryCount} + ${added}` })
        .where(and(eq(fanLibraries.tenant, tenant), eq(fanLibraries.id, libraryId)))
        .run()
    })
    return added
  }

  /** 导出：把历史会话里的客户标识灌进一个新库 */
  exportToLibrary(
    tenant: string,
    name: string,
    channel: LibraryChannel,
    filter: { accountIds?: string[]; from?: number; to?: number } = {}
  ): { library: FanLibrary; added: number } {
    const contactIds = this.contactIdsOfChannel(tenant, channel, filter)
    const library = this.createLibrary(tenant, name, channel, 'export')
    const added = this.addEntries(tenant, library.id, contactIds)
    return { library: { ...library, entryCount: added }, added }
  }

  /** 取某平台历史上出现过的全部客户标识（导出用） */
  contactIdsOfChannel(
    tenant: string,
    channel: LibraryChannel,
    filter: { accountIds?: string[]; from?: number; to?: number } = {}
  ): string[] {
    const conds = [
      eq(conversations.tenant, tenant),
      eq(conversations.channel, channel),
      eq(conversations.isGroup, 0),
      isNotNull(conversations.contactId)
    ]
    if (filter.accountIds?.length) conds.push(inArray(conversations.accountId, filter.accountIds))
    if (filter.from !== undefined) conds.push(gte(messages.timestamp, filter.from))
    if (filter.to !== undefined) conds.push(lte(messages.timestamp, filter.to))

    const rows = this.db
      .selectDistinct({ contactId: conversations.contactId })
      .from(conversations)
      .innerJoin(
        messages,
        and(
          eq(messages.tenant, conversations.tenant),
          eq(messages.conversationId, conversations.id)
        )
      )
      .where(and(...conds))
      .all()
    return rows.map((r) => r.contactId).filter((v): v is string => v !== null)
  }

  /** 所选库里的全部标识（判重用） */
  libraryContacts(tenant: string, libraryIds: string[]): Set<string> {
    const set = new Set<string>()
    for (const batch of chunked(libraryIds)) {
      const rows = this.db
        .selectDistinct({ contactId: fanLibraryEntries.contactId })
        .from(fanLibraryEntries)
        .where(
          and(eq(fanLibraryEntries.tenant, tenant), inArray(fanLibraryEntries.libraryId, batch))
        )
        .all()
      for (const r of rows) set.add(r.contactId)
    }
    return set
  }

  // ── 统计 ──

  /**
   * 取工单窗口内的线索明细。
   * 一个客户可能被多个账号触达 —— 按 contactId 去重，归属**首次**接触的账号。
   */
  leadsOf(tenant: string, campaign: Campaign): LeadRow[] {
    if (campaign.accountIds.length === 0) return []

    const window = (col: typeof messages.timestamp) => {
      const c = [gte(col, campaign.startAt)]
      if (campaign.endAt !== undefined) c.push(lte(col, campaign.endAt))
      return c
    }

    const base = (direction: 'in' | 'out') =>
      this.db
        .select({
          contactId: conversations.contactId,
          channel: conversations.channel,
          accountId: conversations.accountId,
          sourceCode: conversations.leadSourceCode,
          sourceVia: conversations.leadSourceVia,
          at: min(messages.timestamp)
        })
        .from(conversations)
        .innerJoin(
          messages,
          and(
            eq(messages.tenant, conversations.tenant),
            eq(messages.conversationId, conversations.id)
          )
        )
        .where(
          and(
            eq(conversations.tenant, tenant),
            eq(conversations.isGroup, 0),
            isNotNull(conversations.contactId),
            inArray(conversations.accountId, campaign.accountIds),
            eq(messages.direction, direction),
            ...window(messages.timestamp)
          )
        )
        // 按 (客户, 账号) 分组，跨账号的归并放到 JS 里做，避免依赖
        // SQLite 特有的 bare-column 语义，将来换 PostgreSQL 不用改
        .groupBy(
          conversations.contactId,
          conversations.channel,
          conversations.accountId,
          conversations.leadSourceCode,
          conversations.leadSourceVia
        )
        .all()

    const leads = new Map<string, LeadRow>()
    for (const r of base('in')) {
      if (!r.contactId || r.at === null) continue
      const prev = leads.get(r.contactId)
      if (!prev || r.at < prev.firstAt) {
        leads.set(r.contactId, {
          contactId: r.contactId,
          channel: r.channel,
          accountId: r.accountId,
          sourceCode: r.sourceCode ?? undefined,
          sourceVia: r.sourceVia === 'ad' ? 'ad' : r.sourceVia === 'code' ? 'code' : undefined,
          firstAt: r.at
        })
      }
    }

    for (const r of base('out')) {
      if (!r.contactId || r.at === null) continue
      const lead = leads.get(r.contactId)
      if (!lead) continue
      if (lead.firstReplyAt === undefined || r.at < lead.firstReplyAt) lead.firstReplyAt = r.at
    }

    // 投放来源筛选：工单只统计指定来源码的进线（空 = 全部来源）
    const all = [...leads.values()]
    if (campaign.sourceCodes.length === 0) return all
    const wanted = new Set(campaign.sourceCodes)
    return all.filter((l) => l.sourceCode !== undefined && wanted.has(l.sourceCode))
  }

  // ── 推广入口链接（保存多条，按来源区分投放渠道）──

  listEntryLinks(tenant: string): EntryLinkRow[] {
    return this.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.tenant, tenant))
      .orderBy(sql`${entryLinks.createdAt} DESC`)
      .all()
  }

  createEntryLink(
    tenant: string,
    input: { name: string; channel: string; accountId: string; handle: string; code: string; greeting?: string }
  ): EntryLinkRow {
    const row = {
      tenant,
      id: randomUUID(),
      name: input.name,
      channel: input.channel,
      accountId: input.accountId,
      handle: input.handle,
      code: input.code,
      greeting: input.greeting ?? '',
      createdAt: Date.now()
    }
    this.db.insert(entryLinks).values(row).run()
    return row
  }

  deleteEntryLink(tenant: string, id: string): boolean {
    const r = this.db
      .delete(entryLinks)
      .where(and(eq(entryLinks.tenant, tenant), eq(entryLinks.id, id)))
      .run()
    return r.changes > 0
  }

  /**
   * 每个客户的最早接触时间，用于「xx 时间之前出现过即算重复」这条规则。
   *
   * accountIds 为空时看全部账号的历史；给了就只看这些账号 —— 老板常常
   * 想问「这批粉在我另外那几个老号上出现过没有」，而不是整个团队的全量。
   * 不受工单时间窗限制：判的就是「窗口之前有没有出现过」。
   */
  earliestEverAt(
    tenant: string,
    contactIds: string[],
    accountIds: string[] = []
  ): Map<string, number> {
    const out = new Map<string, number>()
    for (const batch of chunked(contactIds)) {
      const rows = this.db
        .select({ contactId: conversations.contactId, at: min(messages.timestamp) })
        .from(conversations)
        .innerJoin(
          messages,
          and(
            eq(messages.tenant, conversations.tenant),
            eq(messages.conversationId, conversations.id)
          )
        )
        .where(
          and(
            eq(conversations.tenant, tenant),
            inArray(conversations.contactId, batch),
            ...(accountIds.length ? [inArray(conversations.accountId, accountIds)] : [])
          )
        )
        .groupBy(conversations.contactId)
        .all()
      for (const r of rows) if (r.contactId && r.at !== null) out.set(r.contactId, r.at)
    }
    return out
  }

  /**
   * 算一份工单统计。返回值只有聚合数字，可以安全地给公开看板。
   * @param accountLabels 账号备注名（老板自己的账号，允许展示）
   */
  statsOf(
    tenant: string,
    campaign: Campaign,
    accountLabels?: Record<string, string>,
    now = Date.now()
  ): CampaignStats {
    const labels = accountLabels ?? campaign.accountLabels
    const leads = this.leadsOf(tenant, campaign)
    const rules = {
      libraryIds: campaign.dedupLibraryIds,
      beforeAt: campaign.dedupBeforeAt
    }
    const stats = computeCampaignStats({
      leads,
      rules,
      libraryContacts:
        rules.libraryIds.length > 0
          ? this.libraryContacts(tenant, rules.libraryIds)
          : new Set<string>(),
      earliestEverAt:
        rules.beforeAt !== undefined
          ? this.earliestEverAt(
              tenant,
              leads.map((l) => l.contactId),
              campaign.dedupAccountIds
            )
          : new Map<string, number>(),
      accountLabels: labels,
      tzOffsetMinutes: campaign.tzOffsetMinutes,
      now
    })
    // 趋势图补齐空白天，截止到工单结束或当前时间
    stats.byDay = fillDays(
      stats.byDay,
      campaign.startAt,
      Math.min(campaign.endAt ?? now, now),
      campaign.tzOffsetMinutes
    )
    return stats
  }
}

function toCampaign(r: typeof campaigns.$inferSelect): Campaign {
  return {
    id: r.id,
    name: r.name,
    accountIds: parseJsonArray(r.accountIds),
    accountLabels: parseJsonObject(r.accountLabels),
    startAt: r.startAt,
    endAt: r.endAt ?? undefined,
    dedupLibraryIds: parseJsonArray(r.dedupLibraryIds),
    dedupBeforeAt: r.dedupBeforeAt ?? undefined,
    dedupAccountIds: parseJsonArray(r.dedupAccountIds),
    sourceCodes: parseJsonArray(r.sourceCodes),
    tzOffsetMinutes: r.tzOffsetMinutes,
    createdBy: r.createdBy ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function toLink(r: typeof campaignLinks.$inferSelect, now = Date.now()): CampaignLink {
  return {
    token: r.token,
    campaignId: r.campaignId,
    label: r.label ?? undefined,
    expiresAt: r.expiresAt ?? undefined,
    revoked: r.revoked === 1,
    createdAt: r.createdAt,
    active: r.revoked !== 1 && (r.expiresAt === null || r.expiresAt > now)
  }
}

function toLibrary(r: typeof fanLibraries.$inferSelect): FanLibrary {
  return {
    id: r.id,
    name: r.name,
    channel: r.channel,
    source: r.source,
    entryCount: r.entryCount,
    createdAt: r.createdAt
  }
}

/** accountId → 备注名；同样容忍脏数据 */
function parseJsonObject(v: string): Record<string, string> {
  try {
    const parsed = JSON.parse(v)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

/** 存的是 JSON 字符串；脏数据不应该让整个列表接口挂掉 */
function parseJsonArray(v: string): string[] {
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
