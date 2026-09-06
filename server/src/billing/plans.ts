import { applyRounding, type Cents } from './money.ts'

/**
 * 套餐周期与升降级折算。
 *
 * 折算（proration）是最容易算错、也最容易引发客诉的地方，所以：
 * - 全部做成纯函数，输入输出都是整数分与毫秒时间戳
 * - **退还给用户的部分向下取整、向用户收取的部分向上取整**，
 *   误差永远倒向用户有利的一侧
 * - 折算基准是**天数**而不是毫秒：用户理解的是"还剩几天"，
 *   按毫秒算会出现"充了一整天却只退 23 小时的钱"这种说不清的情况
 */

export type PeriodUnit = 'month' | 'quarter' | 'half_year' | 'year' | 'day'

/** 各周期折算成天数；月按 30 天、年按 365 天，与账单口径保持一致且可预期 */
const PERIOD_DAYS: Record<Exclude<PeriodUnit, 'day'>, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365
}

export interface PlanPeriod {
  unit: PeriodUnit
  /** unit 为 day 时的自定义天数；其它单位下表示"几个周期"，默认 1 */
  count?: number
}

/** 周期总天数。自定义周期走 unit='day' + count。 */
export function periodDays(period: PlanPeriod): number {
  const count = Math.max(1, Math.floor(period.count ?? 1))
  if (period.unit === 'day') return count
  return PERIOD_DAYS[period.unit] * count
}

const DAY_MS = 86_400_000

/** 从某时刻起算的到期时间 */
export function expiryOf(startAt: number, period: PlanPeriod): number {
  return startAt + periodDays(period) * DAY_MS
}

/**
 * 剩余天数（向上取整）。
 * 用向上取整是因为"还剩半天"在用户眼里就是"还有一天"，
 * 按此退款也更宽松，不会出现少退的争议。
 */
export function remainingDays(now: number, expiresAt: number): number {
  if (expiresAt <= now) return 0
  return Math.ceil((expiresAt - now) / DAY_MS)
}

export interface PlanSnapshot {
  /** 套餐价格（美分） */
  priceCents: Cents
  period: PlanPeriod
}

export interface ProrationResult {
  /** 旧套餐未使用部分折算出的价值（美分），退回余额 */
  creditFromOld: Cents
  /** 新套餐应付金额（美分） */
  chargeForNew: Cents
  /** 净额：正数=还需向用户收，负数=应退回用户余额 */
  net: Cents
  /** 新套餐到期时间 */
  newExpiresAt: number
  /** 旧套餐剩余天数，写进流水便于事后解释 */
  remainingDays: number
}

/**
 * 升级/降级折算，多退少补。
 *
 * 口径：旧套餐按"剩余天数占总天数的比例"折算出剩余价值退回余额，
 * 新套餐按整个周期全额计费，两者相抵得到净额。
 * 这是最好向用户解释的一种口径 —— "没用完的按天退给你，新套餐重新算一个完整周期"。
 *
 * @param now 当前时间
 * @param oldPlan 旧套餐；没有订阅时传 undefined
 * @param oldExpiresAt 旧套餐到期时间
 * @param newPlan 新套餐
 */
export function computeProration(
  now: number,
  oldPlan: PlanSnapshot | undefined,
  oldExpiresAt: number | undefined,
  newPlan: PlanSnapshot
): ProrationResult {
  let creditFromOld = 0
  let left = 0

  if (oldPlan && oldExpiresAt !== undefined) {
    const total = periodDays(oldPlan.period)
    left = remainingDays(now, oldExpiresAt)
    if (left > 0 && total > 0) {
      // 退给用户的部分向下取整
      creditFromOld = applyRounding((oldPlan.priceCents * Math.min(left, total)) / total, 'floor')
    }
  }

  // 向用户收取的部分向上取整
  const chargeForNew = applyRounding(newPlan.priceCents, 'ceil')

  return {
    creditFromOld,
    chargeForNew,
    net: chargeForNew - creditFromOld,
    newExpiresAt: expiryOf(now, newPlan.period),
    remainingDays: left
  }
}

/** 自动续费：在原到期时间上顺延一个周期（而不是从"现在"算，避免用户被吞掉几小时） */
export function renewExpiry(currentExpiresAt: number, now: number, period: PlanPeriod): number {
  // 已经过期很久的话从现在算，否则接着原到期时间续，保证连续订阅不丢时间
  const base = currentExpiresAt > now ? currentExpiresAt : now
  return expiryOf(base, period)
}

/**
 * 账号数是否超出套餐上限。
 * 降级时不强制踢下线（会直接打断客服工作），只禁止新增。
 */
export function accountQuotaState(
  currentAccounts: number,
  maxAccounts: number
): { withinQuota: boolean; canAddMore: boolean; overBy: number } {
  if (maxAccounts === 0) {
    return { withinQuota: true, canAddMore: true, overBy: 0 }
  }
  const over = Math.max(0, currentAccounts - maxAccounts)
  return {
    withinQuota: over === 0,
    canAddMore: currentAccounts < maxAccounts,
    overBy: over
  }
}
