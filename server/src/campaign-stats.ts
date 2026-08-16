/**
 * 工单统计引擎。
 *
 * ⚠️ 硬性约束：本模块的输出只允许包含**聚合数字**。
 * 工单看板是可以公开分享的链接，任何情况下都不得输出聊天内容、客户标识、
 * 昵称、手机号等任何能定位到具体粉丝的信息。所以这里刻意做成纯函数：
 * 输入带 contactId 的明细，输出只有计数 —— 泄不泄露在类型层面就能看出来，
 * 也能用单测钉死（见 campaign-stats.test.ts 的「不泄露」用例）。
 */

/** 一条线索：工单窗口内首次进线的客户（明细，仅在服务端内部流转） */
export interface LeadRow {
  /** 客户唯一标识（跨账号判重用），绝不出现在统计输出里 */
  contactId: string
  channel: string
  /** 首次接触到该客户的账号 */
  accountId: string
  /** 窗口内首次入站时间（毫秒） */
  firstAt: number
  /** 首次人工回复时间（毫秒）；没回复过则为空 */
  firstReplyAt?: number
  /** 投放来源标识（广告 id 或追踪码）；未归因则为空 */
  sourceCode?: string
  /** 归因方式 */
  sourceVia?: 'ad' | 'code'
}

/** 判重规则：命中任意一条即算重复（用户已确认取并集） */
export interface DedupRules {
  /** 选中的重粉库 id；库内的 contactId 视为老粉 */
  libraryIds: string[]
  /** 该时间点之前接触过的视为老粉（毫秒） */
  beforeAt?: number
}

export interface Bucket {
  total: number
  duplicate: number
  fresh: number
}

export interface CampaignStats {
  /** 窗口内进线的去重客户数 */
  total: number
  /** 判定为重复的客户数 */
  duplicate: number
  /** 新粉 */
  fresh: number
  /** 有效客户数；当前口径「联系即有效」→ 等于新粉 */
  effective: number
  /** 重复原因拆分（可叠加，两者之和可能大于 duplicate） */
  duplicateBy: { library: number; timeRange: number }
  /** 按账号拆分；label 是老板自己的账号备注名，不是粉丝信息 */
  byAccount: Array<{ accountId: string; channel: string; label?: string } & Bucket>
  /** 按天趋势（date 为 YYYY-MM-DD） */
  byDay: Array<{ date: string } & Bucket>
  /**
   * 按投放来源拆分。code 是广告 id 或追踪码 —— 是老板自己的投放标识，
   * 不是客户信息，可以在公开看板展示。未归因的客户归到 code 为空的那一行。
   */
  bySource: Array<{ code: string; via?: 'ad' | 'code' } & Bucket>
  /** 客服响应表现 */
  response: {
    /** 有过回复的客户数 */
    replied: number
    /** 回复率 0~1 */
    replyRate: number
    /** 首次响应时长中位数（秒）；无样本为 null */
    medianFirstReplySec: number | null
  }
  computedAt: number
}

const DAY_MS = 86_400_000

/** 按指定时区偏移把时间戳归到 YYYY-MM-DD */
export function dayKey(ts: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ts + tzOffsetMinutes * 60_000)
  return shifted.toISOString().slice(0, 10)
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

/**
 * 判定单个客户是否重复。
 * @param inLibrary 该 contactId 是否在所选重粉库中
 * @param earliestEverAt 该 contactId 在全量数据里的最早接触时间（含本工单之前）
 */
export function isDuplicate(
  rules: DedupRules,
  inLibrary: boolean,
  earliestEverAt: number | undefined
): { duplicate: boolean; byLibrary: boolean; byTimeRange: boolean } {
  const byLibrary = rules.libraryIds.length > 0 && inLibrary
  const byTimeRange =
    rules.beforeAt !== undefined &&
    earliestEverAt !== undefined &&
    earliestEverAt < rules.beforeAt
  return { duplicate: byLibrary || byTimeRange, byLibrary, byTimeRange }
}

export interface ComputeInput {
  leads: LeadRow[]
  rules: DedupRules
  /** 命中所选重粉库的 contactId 集合 */
  libraryContacts: Set<string>
  /** contactId → 全量数据里的最早接触时间，用于时间范围判重 */
  earliestEverAt: Map<string, number>
  /** 账号备注名（老板自己的账号，可展示） */
  accountLabels?: Record<string, string>
  /** 看板时区偏移，默认 UTC+8 */
  tzOffsetMinutes?: number
  now?: number
}

/** 汇总工单统计。输入是明细，输出只有数字。 */
export function computeCampaignStats(input: ComputeInput): CampaignStats {
  const {
    leads,
    rules,
    libraryContacts,
    earliestEverAt,
    accountLabels = {},
    tzOffsetMinutes = 480,
    now = 0
  } = input

  const byAccount = new Map<string, { channel: string } & Bucket>()
  const byDay = new Map<string, Bucket>()
  const bySource = new Map<string, { via?: 'ad' | 'code' } & Bucket>()
  let duplicate = 0
  let byLibraryCount = 0
  let byTimeCount = 0
  const replyDurations: number[] = []
  let replied = 0

  // 同一个客户可能被多个账号触达，leads 已按 contactId 去重（归属首次接触的账号）
  for (const lead of leads) {
    const verdict = isDuplicate(
      rules,
      libraryContacts.has(lead.contactId),
      earliestEverAt.get(lead.contactId)
    )
    if (verdict.duplicate) duplicate++
    if (verdict.byLibrary) byLibraryCount++
    if (verdict.byTimeRange) byTimeCount++

    const acc = byAccount.get(lead.accountId) ?? {
      channel: lead.channel,
      total: 0,
      duplicate: 0,
      fresh: 0
    }
    acc.total++
    if (verdict.duplicate) acc.duplicate++
    else acc.fresh++
    byAccount.set(lead.accountId, acc)

    const key = dayKey(lead.firstAt, tzOffsetMinutes)
    const day = byDay.get(key) ?? { total: 0, duplicate: 0, fresh: 0 }
    day.total++
    if (verdict.duplicate) day.duplicate++
    else day.fresh++
    byDay.set(key, day)

    // 未归因的客户也要统计，否则各来源相加对不上总数
    const sourceKey = lead.sourceCode ?? ''
    const src = bySource.get(sourceKey) ?? {
      via: lead.sourceVia,
      total: 0,
      duplicate: 0,
      fresh: 0
    }
    src.total++
    if (verdict.duplicate) src.duplicate++
    else src.fresh++
    bySource.set(sourceKey, src)

    if (lead.firstReplyAt !== undefined && lead.firstReplyAt >= lead.firstAt) {
      replied++
      replyDurations.push(Math.round((lead.firstReplyAt - lead.firstAt) / 1000))
    }
  }

  const total = leads.length
  const fresh = total - duplicate

  return {
    total,
    duplicate,
    fresh,
    effective: fresh,
    duplicateBy: { library: byLibraryCount, timeRange: byTimeCount },
    byAccount: [...byAccount.entries()]
      .map(([accountId, v]) => ({
        accountId,
        channel: v.channel,
        label: accountLabels[accountId],
        total: v.total,
        duplicate: v.duplicate,
        fresh: v.fresh
      }))
      .sort((a, b) => b.total - a.total || a.accountId.localeCompare(b.accountId)),
    byDay: [...byDay.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    bySource: [...bySource.entries()]
      .map(([code, v]) => ({ code, via: v.via, total: v.total, duplicate: v.duplicate, fresh: v.fresh }))
      // 量大的排前面；未归因（空 code）永远排最后，它不是一个"来源"
      .sort((a, b) => (a.code === '' ? 1 : b.code === '' ? -1 : b.total - a.total)),
    response: {
      replied,
      replyRate: total === 0 ? 0 : Number((replied / total).toFixed(4)),
      medianFirstReplySec: median(replyDurations)
    },
    computedAt: now
  }
}

/** 把按天数据补齐成连续日期（前端画趋势图不用自己补洞） */
export function fillDays(
  days: Array<{ date: string } & Bucket>,
  startAt: number,
  endAt: number,
  tzOffsetMinutes = 480
): Array<{ date: string } & Bucket> {
  if (endAt < startAt) return []
  const known = new Map(days.map((d) => [d.date, d]))
  const out: Array<{ date: string } & Bucket> = []
  // 以时区内的当天零点为步进起点，避免跨月/跨年时手工算日期出错
  for (let t = startAt; t <= endAt + DAY_MS; t += DAY_MS) {
    const key = dayKey(t, tzOffsetMinutes)
    if (out.some((d) => d.date === key)) continue
    if (key > dayKey(endAt, tzOffsetMinutes)) break
    out.push(known.get(key) ?? { date: key, total: 0, duplicate: 0, fresh: 0 })
  }
  return out
}
