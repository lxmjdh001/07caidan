import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, isNotNull, lte, min, sql } from 'drizzle-orm'
import {
  computeCampaignStats,
  fillDays,
  dayKey,
  isDuplicate,
  normalizeResetTime,
  resetBoundaryAt,
  type CampaignStats,
  type LeadRow
} from './campaign-stats.ts'
import type { LibraryChannel } from './contact-id.ts'
import type { Db } from './db.ts'
import { hashPassword, verifyPassword } from './auth.ts'
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
/** 工单统计统一使用北京时间（UTC+8），不跟随创建者或服务器本地时区。 */
const BEIJING_TZ_OFFSET_MINUTES = 480

export interface Campaign {
  id: string
  name: string
  accountIds: string[]
  accountLabels: Record<string, string>
  accountProfiles: Record<string, AccountProfile>
  /** 工单总目标数 */
  totalTarget: number
  /** 分享页是否启用访问密码；密码哈希不返回 */
  accessPasswordEnabled: boolean
  /** accountId → 该账号目标数 */
  accountTargets: Record<string, number>
  accountTargetsManual: boolean
  /** 每日统计重置时间，按北京时间解释，格式 HH:mm */
  resetTime: string
  startAt: number
  endAt?: number
  dedupLibraryIds: string[]
  dedupBeforeAt?: number
  /** 时间规则的统计范围；空 = 全部账号 */
  dedupAccountIds: string[]
  /** 只统计这些投放来源码；空 = 全部来源 */
  sourceCodes: string[]
  /** 公开看板是否允许中国大陆 / 香港 IP（默认都不允许） */
  allowCnIp: boolean
  allowHkIp: boolean
  /** 固定为北京时间 UTC+8；保留字段兼容旧数据。 */
  tzOffsetMinutes: number
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export interface AccountProfile {
  channel: string
  handle?: string
  avatarMediaId?: string
  status?: 'online' | 'offline' | 'error' | 'removed'
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
  accountProfiles?: Record<string, AccountProfile>
  totalTarget?: number
  accessPasswordEnabled?: boolean
  accessPassword?: string
  accountTargets?: Record<string, number>
  accountTargetsManual?: boolean
  resetTime?: string
  startAt: number
  endAt?: number
  dedupLibraryIds?: string[]
  dedupBeforeAt?: number
  dedupAccountIds?: string[]
  sourceCodes?: string[]
  allowCnIp?: boolean
  allowHkIp?: boolean
  tzOffsetMinutes?: number
}

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 工单 / 分享链接 / 重粉库的数据访问层 */
/** 工单统计 TTL 缓存时长：公开看板会被打粉团队高频刷新，30s 缓存足以扛住而不失实时感 */
const STATS_TTL_MS = 30_000

export class CampaignRepo {
  private readonly db: Db
  /** 统计结果缓存。key = tenant:campaignId:updatedAt（改工单即换 key 自动失效） */
  private readonly statsCache = new Map<string, { stats: CampaignStats; expiresAt: number }>()

  constructor(db: Db) {
    this.db = db
  }

  /** 手动清空统计缓存（测试或必要时的强制失效用） */
  invalidateStats(): void {
    this.statsCache.clear()
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
      accountProfiles: JSON.stringify(input.accountProfiles ?? {}),
      totalTarget: normalizeTarget(input.totalTarget),
      accessPasswordEnabled: input.accessPasswordEnabled ? 1 : 0,
      accessPasswordHash: input.accessPasswordEnabled && input.accessPassword ? hashPassword(input.accessPassword) : null,
      accountTargets: JSON.stringify(
        input.accountTargets === undefined
          ? distributeAccountTargets(input.accountIds, input.totalTarget)
          : normalizeAccountTargets(input.accountTargets)
      ),
      accountTargetsManual: input.accountTargetsManual ? 1 : 0,
      resetTime: normalizeResetTime(input.resetTime),
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      dedupLibraryIds: JSON.stringify(input.dedupLibraryIds ?? []),
      dedupBeforeAt: input.dedupBeforeAt ?? null,
      dedupAccountIds: JSON.stringify(input.dedupAccountIds ?? []),
      sourceCodes: JSON.stringify(input.sourceCodes ?? []),
      allowCnIp: input.allowCnIp ? 1 : 0,
      allowHkIp: input.allowHkIp ? 1 : 0,
      // 工单统计口径固定为北京时间，忽略客户端传入的本机时区。
      tzOffsetMinutes: BEIJING_TZ_OFFSET_MINUTES,
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
    if (patch.accountProfiles !== undefined) {
      set.accountProfiles = JSON.stringify(patch.accountProfiles)
    }
    if (patch.totalTarget !== undefined) set.totalTarget = normalizeTarget(patch.totalTarget)
    if (patch.accessPasswordEnabled !== undefined) {
      set.accessPasswordEnabled = patch.accessPasswordEnabled ? 1 : 0
      if (!patch.accessPasswordEnabled) set.accessPasswordHash = null
      else if (patch.accessPassword) set.accessPasswordHash = hashPassword(patch.accessPassword)
    } else if (patch.accessPassword) {
      set.accessPasswordHash = hashPassword(patch.accessPassword)
    }
    if (patch.accountTargets !== undefined) {
      set.accountTargets = JSON.stringify(normalizeAccountTargets(patch.accountTargets))
    }
    if (patch.accountTargetsManual !== undefined) set.accountTargetsManual = patch.accountTargetsManual ? 1 : 0
    if (patch.resetTime !== undefined) set.resetTime = normalizeResetTime(patch.resetTime)
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
    if (patch.allowCnIp !== undefined) set.allowCnIp = patch.allowCnIp ? 1 : 0
    if (patch.allowHkIp !== undefined) set.allowHkIp = patch.allowHkIp ? 1 : 0
    if (patch.tzOffsetMinutes !== undefined) set.tzOffsetMinutes = BEIJING_TZ_OFFSET_MINUTES
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
      // 注意：不能写 .map(toLink) —— map 会把数组下标当作 toLink 的第二参 now，
      // 导致 active 用 now=0 计算，过期链接被误判为有效。必须用箭头包一层。
      .map((r) => toLink(r))
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

  /** 恢复手动失效的链接；若链接已过期，恢复后仍会保持过期状态。 */
  restoreLink(tenant: string, token: string): boolean {
    const res = this.db
      .update(campaignLinks)
      .set({ revoked: 0 })
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

  verifyAccessPassword(tenant: string, campaign: Campaign, password: string): boolean {
    if (!campaign.accessPasswordEnabled) return true
    const row = this.db
      .select({ hash: campaigns.accessPasswordHash })
      .from(campaigns)
      .where(and(eq(campaigns.tenant, tenant), eq(campaigns.id, campaign.id)))
      .get()
    return Boolean(row?.hash && verifyPassword(password, row.hash))
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
   * 一个客户可能被多个账号触达 —— 每个账号保留一条首次进线，后续账号标记为重复。
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

    // 一个客户在同一账号可能有多个会话，只取该账号最早的一次进线；
    // 不能只用 contactId 做 key，否则同工单内后续账号会被错误丢弃。
    const leadKey = (contactId: string, accountId: string): string => `${contactId}\u0000${accountId}`
    const leads = new Map<string, LeadRow>()
    for (const r of base('in')) {
      if (!r.contactId || r.at === null) continue
      const key = leadKey(r.contactId, r.accountId)
      const prev = leads.get(key)
      if (!prev || r.at < prev.firstAt) {
        leads.set(key, {
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
      const lead = leads.get(leadKey(r.contactId, r.accountId))
      if (!lead) continue
      if (lead.firstReplyAt === undefined || r.at < lead.firstReplyAt) lead.firstReplyAt = r.at
    }

    // 投放来源筛选：工单只统计指定来源码的进线（空 = 全部来源）
    const all = [...leads.values()]
    const wanted = new Set(campaign.sourceCodes)
    const filtered = campaign.sourceCodes.length === 0
      ? all
      : all.filter((l) => l.sourceCode !== undefined && wanted.has(l.sourceCode))

    // 只在筛选后的有效进线中判定先后，避免未选中的来源抢走“首次”资格。
    const seenContacts = new Set<string>()
    return filtered
      .sort((a, b) => a.firstAt - b.firstAt || a.accountId.localeCompare(b.accountId))
      .map((lead) => {
        const campaignDuplicate = seenContacts.has(lead.contactId)
        seenContacts.add(lead.contactId)
        return campaignDuplicate ? { ...lead, campaignDuplicate: true } : lead
      })
  }

  // ── 推广入口链接（保存多条，按来源区分投放渠道）──

  listEntryLinks(tenant: string): EntryLinkRow[] {
    return this.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.tenant, tenant))
      // 同毫秒创建时 created_at 会打平，用 rowid(插入顺序)兜底，保证"新的在前"稳定
      .orderBy(sql`${entryLinks.createdAt} DESC, rowid DESC`)
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
    // 传了自定义 labels 的调用（非默认展示名）绕过缓存，避免把一份 labels 的结果串给另一个调用者
    const cacheable = accountLabels === undefined
    const key = `${tenant}:${campaign.id}:${campaign.updatedAt}`
    if (cacheable) {
      const hit = this.statsCache.get(key)
      if (hit && now < hit.expiresAt) return hit.stats
    }
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
      tzOffsetMinutes: BEIJING_TZ_OFFSET_MINUTES,
      todayStartAt: Math.max(
        campaign.startAt,
        resetBoundaryAt(now, BEIJING_TZ_OFFSET_MINUTES, campaign.resetTime)
      ),
      now
    })

    // 工单保存的是创建/编辑时的账号资料快照，统计结果一并带回给分享页。
    const profiles = campaign.accountProfiles ?? {}
    for (const row of stats.byAccount) {
      const profile = profiles[row.accountId]
      if (profile && typeof profile === 'object') {
        row.handle = profile.handle
        row.avatarMediaId = profile.avatarMediaId
        row.status = profile.status
      }
    }

    // 账号列表代表工单的参与账号，而不只是窗口内已经产生线索的账号。
    // 没有进线的账号也要展示，避免新建工单后看板误显示“共 0 个账号”。
    const selectedAccountIds = [...new Set(campaign.accountIds)]
    const existingAccountIds = new Set(stats.byAccount.map((row) => row.accountId))
    const missingAccountIds = selectedAccountIds.filter((id) => !existingAccountIds.has(id))
    if (missingAccountIds.length > 0) {
      // conversations 是目前服务端保存账号平台信息的唯一来源；没有历史会话时平台留空，
      // 但账号仍然会出现在“所属账号”的全部列表中。
      const channels = new Map<string, string>()
      for (const batch of chunked(missingAccountIds)) {
        const rows = this.db
          .select({ accountId: conversations.accountId, channel: conversations.channel })
          .from(conversations)
          .where(and(eq(conversations.tenant, tenant), inArray(conversations.accountId, batch)))
          .groupBy(conversations.accountId, conversations.channel)
          .all()
        for (const row of rows) {
          if (!channels.has(row.accountId)) channels.set(row.accountId, row.channel)
        }
      }
      for (const accountId of missingAccountIds) {
        stats.byAccount.push({
          accountId,
          channel: channels.get(accountId) ?? profiles[accountId]?.channel ?? '',
          label: labels[accountId],
          handle: profiles[accountId]?.handle,
          avatarMediaId: profiles[accountId]?.avatarMediaId,
          status: profiles[accountId]?.status ?? 'offline',
          lastAt: undefined,
          dayTotal: 0,
          dayFresh: 0,
          dayDuplicate: 0,
          total: 0,
          duplicate: 0,
          fresh: 0
        })
      }
      stats.byAccount.sort((a, b) => b.total - a.total || a.accountId.localeCompare(b.accountId))
    }

    // 删除客户端账号不能抹掉该账号已经产生的工单成绩。账号仍保留在
    // campaign.accountIds 中，只用 removed 状态区分并汇总历史/今日数据。
    const removedRows = stats.byAccount.filter((row) => row.status === 'removed')
    stats.removed = {
      accounts: removedRows.length,
      total: removedRows.reduce((sum, row) => sum + row.total, 0),
      duplicate: removedRows.reduce((sum, row) => sum + row.duplicate, 0),
      fresh: removedRows.reduce((sum, row) => sum + row.fresh, 0),
      dayTotal: removedRows.reduce((sum, row) => sum + row.dayTotal, 0),
      dayFresh: removedRows.reduce((sum, row) => sum + row.dayFresh, 0),
      dayDuplicate: removedRows.reduce((sum, row) => sum + row.dayDuplicate, 0)
    }

    // 趋势图补齐空白天，截止到工单结束或当前时间
    stats.byDay = fillDays(
      stats.byDay,
      campaign.startAt,
      Math.min(campaign.endAt ?? now, now),
      BEIJING_TZ_OFFSET_MINUTES
    )
    if (cacheable) {
      // 换 updatedAt 的旧条目一并清掉，避免改工单后残留过期 key
      const prefix = `${tenant}:${campaign.id}:`
      for (const k of this.statsCache.keys()) if (k.startsWith(prefix) && k !== key) this.statsCache.delete(k)
      this.statsCache.set(key, { stats, expiresAt: now + STATS_TTL_MS })
    }
    return stats
  }

  accountFansOf(tenant: string, campaign: Campaign, accountId: string): Array<{ contactId: string; title?: string; firstAt: number; duplicate: boolean; duplicateCount: number }> {
    if (!campaign.accountIds.includes(accountId)) return []
    const leads = this.leadsOf(tenant, campaign)
    const libraryContacts = campaign.dedupLibraryIds.length > 0 ? this.libraryContacts(tenant, campaign.dedupLibraryIds) : new Set<string>()
    const earliestEverAt = campaign.dedupBeforeAt !== undefined ? this.earliestEverAt(tenant, leads.map((lead) => lead.contactId), campaign.dedupAccountIds) : new Map<string, number>()
    const counts = new Map<string, number>()
    for (const lead of leads) counts.set(lead.contactId, (counts.get(lead.contactId) ?? 0) + 1)
    const contacts = leads.filter((lead) => lead.accountId === accountId)
    const titles = new Map<string, string>()
    for (const batch of chunked([...new Set(contacts.map((lead) => lead.contactId))])) {
      const rows = this.db.select({ contactId: conversations.contactId, title: conversations.title }).from(conversations).where(and(eq(conversations.tenant, tenant), eq(conversations.accountId, accountId), inArray(conversations.contactId, batch))).all()
      for (const row of rows) if (row.contactId && !titles.has(row.contactId)) titles.set(row.contactId, row.title)
    }
    return contacts.map((lead) => ({
      contactId: lead.contactId,
      title: titles.get(lead.contactId),
      firstAt: lead.firstAt,
      duplicate: isDuplicate({ libraryIds: campaign.dedupLibraryIds, beforeAt: campaign.dedupBeforeAt }, libraryContacts.has(lead.contactId), earliestEverAt.get(lead.contactId)).duplicate || lead.campaignDuplicate === true,
      duplicateCount: Math.max(0, (counts.get(lead.contactId) ?? 1) - 1)
    })).sort((a, b) => b.firstAt - a.firstAt)
  }

  accountTrendOf(tenant: string, campaign: Campaign, accountId: string, now = Date.now()): Array<{ date: string; total: number; fresh: number; duplicate: number }> {
    const fans = this.accountFansOf(tenant, campaign, accountId)
    const byDay = new Map<string, { date: string; total: number; fresh: number; duplicate: number }>()
    for (const fan of fans) {
      const date = dayKey(fan.firstAt, BEIJING_TZ_OFFSET_MINUTES)
      const row = byDay.get(date) ?? { date, total: 0, fresh: 0, duplicate: 0 }
      row.total++
      if (fan.duplicate) row.duplicate++
      else row.fresh++
      byDay.set(date, row)
    }
    const cutoff = dayKey(now - 6 * 86_400_000, BEIJING_TZ_OFFSET_MINUTES)
    return [...byDay.values()].filter((row) => row.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date))
  }
}

function toCampaign(r: typeof campaigns.$inferSelect): Campaign {
  return {
    id: r.id,
    name: r.name,
    accountIds: parseJsonArray(r.accountIds),
    accountLabels: parseJsonObject(r.accountLabels),
    accountProfiles: parseJsonProfiles(r.accountProfiles),
    totalTarget: normalizeTarget(r.totalTarget),
    accessPasswordEnabled: r.accessPasswordEnabled === 1,
    accountTargets: parseJsonNumberObject(r.accountTargets),
    accountTargetsManual: r.accountTargetsManual === 1,
    resetTime: normalizeResetTime(r.resetTime),
    startAt: r.startAt,
    endAt: r.endAt ?? undefined,
    dedupLibraryIds: parseJsonArray(r.dedupLibraryIds),
    dedupBeforeAt: r.dedupBeforeAt ?? undefined,
    dedupAccountIds: parseJsonArray(r.dedupAccountIds),
    sourceCodes: parseJsonArray(r.sourceCodes),
    allowCnIp: r.allowCnIp === 1,
    allowHkIp: r.allowHkIp === 1,
    // 旧工单可能保存过其他偏移，但统计口径统一按北京时间。
    tzOffsetMinutes: BEIJING_TZ_OFFSET_MINUTES,
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

function normalizeTarget(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

function normalizeAccountTargets(value?: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, target]) => [id, normalizeTarget(target)] as const)
      .filter(([, target]) => target > 0)
  )
}

function distributeAccountTargets(accountIds: string[], totalTarget: unknown): Record<string, number> {
  const ids = [...new Set(accountIds)]
  const total = normalizeTarget(totalTarget)
  if (ids.length === 0 || total === 0) return {}
  const base = Math.floor(total / ids.length)
  const remainder = total % ids.length
  return Object.fromEntries(ids.map((id, index) => [id, base + (index < remainder ? 1 : 0)]))
}

function parseJsonNumberObject(v: string): Record<string, number> {
  try {
    const parsed = JSON.parse(v)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return normalizeAccountTargets(parsed as Record<string, number>)
  } catch {
    return {}
  }
}

function parseJsonProfiles(v: string): Record<string, AccountProfile> {
  try {
    const parsed = JSON.parse(v)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, AccountProfile> = {}
    for (const [accountId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const profile = value as Record<string, unknown>
      if (typeof profile.channel !== 'string') continue
      out[accountId] = {
        channel: profile.channel,
        ...(typeof profile.handle === 'string' ? { handle: profile.handle } : {}),
        ...(typeof profile.avatarMediaId === 'string' ? { avatarMediaId: profile.avatarMediaId } : {}),
        ...(profile.status === 'online' || profile.status === 'offline' || profile.status === 'error' || profile.status === 'removed'
          ? { status: profile.status }
          : {})
      }
    }
    return out
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
