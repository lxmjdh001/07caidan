import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { balances, ledger, plans, subscriptions } from '../schema.ts'
import { deductCredits, type CreditRate } from './credits.ts'
import type { Cents } from './money.ts'
import {
  accountQuotaState,
  computeProration,
  renewExpiry,
  type PeriodUnit,
  type PlanPeriod,
  type PlanSnapshot
} from './plans.ts'

export interface Plan {
  id: string
  name: string
  priceCents: Cents
  periodUnit: PeriodUnit
  periodCount: number
  maxAccounts: number
  enabled: boolean
  sortOrder: number
  createdAt: number
}

export interface PlanInput {
  name: string
  priceCents: Cents
  periodUnit: PeriodUnit
  periodCount?: number
  maxAccounts: number
  enabled?: boolean
  sortOrder?: number
}

export interface Subscription {
  userId: number
  planId: string
  startAt: number
  expiresAt: number
  autoRenew: boolean
  status: string
}

export interface Balance {
  userId: number
  balanceCents: Cents
  credits: number
}

export type LedgerKind =
  | 'topup'
  | 'plan_purchase'
  | 'proration_refund'
  | 'renew'
  | 'credit_exchange'
  | 'model_usage'
  | 'adjust'

export interface LedgerEntry {
  id: number
  kind: LedgerKind
  amountCents: Cents
  creditsDelta: number
  balanceAfter: Cents
  creditsAfter: number
  refType?: string
  refId?: string
  note?: string
  createdAt: number
}

/** 余额变动请求；amountCents / creditsDelta 为有符号值 */
export interface MutateInput {
  userId: number
  kind: LedgerKind
  amountCents?: Cents
  creditsDelta?: number
  refType?: string
  refId?: string
  note?: string
  /** 是否允许扣成负数（默认不允许，防止透支） */
  allowNegative?: boolean
  now?: number
}

export interface MutateResult {
  ok: boolean
  balance: Balance
  reason?: 'insufficient_balance' | 'insufficient_credits'
}

/**
 * 计费数据访问层。
 *
 * 核心原则：**余额只能通过 mutate() 变动，且必然同时写一条流水**。
 * 任何绕开这里直接 UPDATE balances 的代码都会让账对不上 ——
 * 到那时你既不知道钱去哪了，也没法向用户解释。
 */
export class BillingRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // ── 套餐 ──

  createPlan(tenant: string, input: PlanInput): Plan {
    const row = {
      tenant,
      id: randomUUID(),
      name: input.name,
      priceCents: Math.max(0, Math.round(input.priceCents)),
      periodUnit: input.periodUnit,
      periodCount: Math.max(1, Math.floor(input.periodCount ?? 1)),
      maxAccounts: Math.max(0, Math.floor(input.maxAccounts)),
      enabled: input.enabled === false ? 0 : 1,
      sortOrder: input.sortOrder ?? 0,
      createdAt: Date.now()
    }
    this.db.insert(plans).values(row).run()
    return toPlan(row as typeof plans.$inferSelect)
  }

  listPlans(tenant: string, onlyEnabled = false): Plan[] {
    const rows = this.db
      .select()
      .from(plans)
      .where(
        onlyEnabled
          ? and(eq(plans.tenant, tenant), eq(plans.enabled, 1))
          : eq(plans.tenant, tenant)
      )
      .orderBy(plans.sortOrder, plans.createdAt)
      .all()
    return rows.map(toPlan)
  }

  getPlan(tenant: string, id: string): Plan | null {
    const r = this.db
      .select()
      .from(plans)
      .where(and(eq(plans.tenant, tenant), eq(plans.id, id)))
      .get()
    return r ? toPlan(r) : null
  }

  updatePlan(tenant: string, id: string, patch: Partial<PlanInput>): boolean {
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.priceCents !== undefined) set.priceCents = Math.max(0, Math.round(patch.priceCents))
    if (patch.periodUnit !== undefined) set.periodUnit = patch.periodUnit
    if (patch.periodCount !== undefined) {
      set.periodCount = Math.max(1, Math.floor(patch.periodCount))
    }
    if (patch.maxAccounts !== undefined) set.maxAccounts = Math.max(0, Math.floor(patch.maxAccounts))
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (Object.keys(set).length === 0) return true
    const res = this.db
      .update(plans)
      .set(set)
      .where(and(eq(plans.tenant, tenant), eq(plans.id, id)))
      .run()
    return res.changes > 0
  }

  /** 停用而不是删除：已订阅的用户还引用着它，删掉会让历史订单失去上下文 */
  disablePlan(tenant: string, id: string): boolean {
    return this.updatePlan(tenant, id, { enabled: false })
  }

  // ── 余额与流水 ──

  getBalance(tenant: string, userId: number): Balance {
    const r = this.db
      .select()
      .from(balances)
      .where(and(eq(balances.tenant, tenant), eq(balances.userId, userId)))
      .get()
    return r
      ? { userId, balanceCents: r.balanceCents, credits: r.credits }
      : { userId, balanceCents: 0, credits: 0 }
  }

  /**
   * 变更余额/积分并记一条流水（同一事务）。
   * 默认不允许扣成负数 —— 宁可让这次操作失败，也不能让用户透支。
   */
  mutate(tenant: string, input: MutateInput): MutateResult {
    const now = input.now ?? Date.now()
    const amount = Math.round(input.amountCents ?? 0)
    const creditsDelta = Math.round(input.creditsDelta ?? 0)

    return this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(balances)
        .where(and(eq(balances.tenant, tenant), eq(balances.userId, input.userId)))
        .get()
      const balanceCents = current?.balanceCents ?? 0
      const credits = current?.credits ?? 0

      const nextBalance = balanceCents + amount
      const nextCredits = credits + creditsDelta

      if (!input.allowNegative) {
        if (nextBalance < 0) {
          return {
            ok: false as const,
            balance: { userId: input.userId, balanceCents, credits },
            reason: 'insufficient_balance' as const
          }
        }
        if (nextCredits < 0) {
          return {
            ok: false as const,
            balance: { userId: input.userId, balanceCents, credits },
            reason: 'insufficient_credits' as const
          }
        }
      }

      tx.insert(balances)
        .values({
          tenant,
          userId: input.userId,
          balanceCents: nextBalance,
          credits: nextCredits,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [balances.tenant, balances.userId],
          set: {
            balanceCents: sql`excluded.balance_cents`,
            credits: sql`excluded.credits`,
            updatedAt: sql`excluded.updated_at`
          }
        })
        .run()

      tx.insert(ledger)
        .values({
          tenant,
          userId: input.userId,
          kind: input.kind,
          amountCents: amount,
          creditsDelta,
          balanceAfter: nextBalance,
          creditsAfter: nextCredits,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          note: input.note ?? null,
          createdAt: now
        })
        .run()

      return {
        ok: true as const,
        balance: { userId: input.userId, balanceCents: nextBalance, credits: nextCredits }
      }
    })
  }

  listLedger(tenant: string, userId: number, limit = 100): LedgerEntry[] {
    return this.db
      .select()
      .from(ledger)
      .where(and(eq(ledger.tenant, tenant), eq(ledger.userId, userId)))
      .orderBy(desc(ledger.createdAt), desc(ledger.id))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        kind: r.kind as LedgerKind,
        amountCents: r.amountCents,
        creditsDelta: r.creditsDelta,
        balanceAfter: r.balanceAfter,
        creditsAfter: r.creditsAfter,
        refType: r.refType ?? undefined,
        refId: r.refId ?? undefined,
        note: r.note ?? undefined,
        createdAt: r.createdAt
      }))
  }

  /**
   * 对账：把流水从头累加，看是否等于当前余额。
   * 有了它，一旦有人绕过 mutate 直接改表，测试和运维都能立刻发现。
   */
  auditBalance(
    tenant: string,
    userId: number
  ): { consistent: boolean; fromLedger: Balance; stored: Balance } {
    const rows = this.db
      .select()
      .from(ledger)
      .where(and(eq(ledger.tenant, tenant), eq(ledger.userId, userId)))
      .all()
    const fromLedger = rows.reduce(
      (acc, r) => ({
        userId,
        balanceCents: acc.balanceCents + r.amountCents,
        credits: acc.credits + r.creditsDelta
      }),
      { userId, balanceCents: 0, credits: 0 } as Balance
    )
    const stored = this.getBalance(tenant, userId)
    return {
      consistent:
        fromLedger.balanceCents === stored.balanceCents && fromLedger.credits === stored.credits,
      fromLedger,
      stored
    }
  }

  // ── 订阅 ──

  getSubscription(tenant: string, userId: number): Subscription | null {
    const r = this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.tenant, tenant), eq(subscriptions.userId, userId)))
      .get()
    return r
      ? {
          userId: r.userId,
          planId: r.planId,
          startAt: r.startAt,
          expiresAt: r.expiresAt,
          autoRenew: r.autoRenew === 1,
          status: r.status
        }
      : null
  }

  private putSubscription(tenant: string, sub: Subscription, now: number): void {
    this.db
      .insert(subscriptions)
      .values({
        tenant,
        userId: sub.userId,
        planId: sub.planId,
        startAt: sub.startAt,
        expiresAt: sub.expiresAt,
        autoRenew: sub.autoRenew ? 1 : 0,
        status: sub.status,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [subscriptions.tenant, subscriptions.userId],
        set: {
          planId: sql`excluded.plan_id`,
          startAt: sql`excluded.start_at`,
          expiresAt: sql`excluded.expires_at`,
          autoRenew: sql`excluded.auto_renew`,
          status: sql`excluded.status`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .run()
  }

  /** 未来 before 之前到期、当前仍生效的订阅（到期提醒用） */
  listExpiringSubscriptions(tenant: string, before: number, now = Date.now()): Subscription[] {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenant, tenant),
          eq(subscriptions.status, 'active'),
          sql`${subscriptions.expiresAt} > ${now}`,
          sql`${subscriptions.expiresAt} <= ${before}`
        )
      )
      .all()
      .map((r) => ({
        userId: r.userId,
        planId: r.planId,
        startAt: r.startAt,
        expiresAt: r.expiresAt,
        autoRenew: r.autoRenew === 1,
        status: r.status
      }))
  }

  /** 到期的生效订阅（定时任务处理续费/过期用） */
  listDueSubscriptions(tenant: string, now = Date.now()): Subscription[] {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenant, tenant),
          eq(subscriptions.status, 'active'),
          sql`${subscriptions.expiresAt} <= ${now}`
        )
      )
      .all()
      .map((r) => ({
        userId: r.userId,
        planId: r.planId,
        startAt: r.startAt,
        expiresAt: r.expiresAt,
        autoRenew: r.autoRenew === 1,
        status: r.status
      }))
  }

  setAutoRenew(tenant: string, userId: number, on: boolean): boolean {
    const res = this.db
      .update(subscriptions)
      .set({ autoRenew: on ? 1 : 0, updatedAt: Date.now() })
      .where(and(eq(subscriptions.tenant, tenant), eq(subscriptions.userId, userId)))
      .run()
    return res.changes > 0
  }

  /**
   * 用余额购买/切换套餐，按时间折算多退少补。
   *
   * 净额为正 → 从余额扣；为负 → 差额退回余额。
   * 余额不足时整笔失败，不留半成品订阅。
   */
  changePlan(
    tenant: string,
    userId: number,
    newPlanId: string,
    now = Date.now()
  ):
    | { ok: true; subscription: Subscription; net: Cents; creditFromOld: Cents; balance: Balance }
    | { ok: false; reason: 'plan_not_found' | 'plan_disabled' | 'insufficient_balance' } {
    const newPlan = this.getPlan(tenant, newPlanId)
    if (!newPlan) return { ok: false, reason: 'plan_not_found' }
    if (!newPlan.enabled) return { ok: false, reason: 'plan_disabled' }

    const current = this.getSubscription(tenant, userId)
    const oldPlan = current ? this.getPlan(tenant, current.planId) : null

    const proration = computeProration(
      now,
      oldPlan && current?.status === 'active' ? toSnapshot(oldPlan) : undefined,
      current?.status === 'active' ? current.expiresAt : undefined,
      toSnapshot(newPlan)
    )

    // 先试算余额是否够；不够就整笔拒绝，不写任何东西
    if (proration.net > 0) {
      const balance = this.getBalance(tenant, userId)
      if (balance.balanceCents < proration.net) {
        return { ok: false, reason: 'insufficient_balance' }
      }
    }

    // 折算退款与新套餐扣款分成两条流水，账面上能看清"退了多少、又收了多少"
    if (proration.creditFromOld > 0) {
      this.mutate(tenant, {
        userId,
        kind: 'proration_refund',
        amountCents: proration.creditFromOld,
        refType: 'plan',
        refId: current?.planId,
        note: `旧套餐剩余 ${proration.remainingDays} 天折算`,
        now
      })
    }
    if (proration.chargeForNew > 0) {
      const r = this.mutate(tenant, {
        userId,
        kind: 'plan_purchase',
        amountCents: -proration.chargeForNew,
        refType: 'plan',
        refId: newPlanId,
        note: newPlan.name,
        now
      })
      if (!r.ok) {
        // 理论上前面已试算过，走到这里说明有并发；把刚退的钱冲回去，保持账平
        if (proration.creditFromOld > 0) {
          this.mutate(tenant, {
            userId,
            kind: 'adjust',
            amountCents: -proration.creditFromOld,
            refType: 'plan',
            refId: newPlanId,
            note: '并发导致换购失败，冲回折算退款',
            allowNegative: true,
            now
          })
        }
        return { ok: false, reason: 'insufficient_balance' }
      }
    }

    const subscription: Subscription = {
      userId,
      planId: newPlanId,
      startAt: now,
      expiresAt: proration.newExpiresAt,
      autoRenew: current?.autoRenew ?? false,
      status: 'active'
    }
    this.putSubscription(tenant, subscription, now)

    return {
      ok: true,
      subscription,
      net: proration.net,
      creditFromOld: proration.creditFromOld,
      balance: this.getBalance(tenant, userId)
    }
  }

  /**
   * 到期自动续费。余额不足则标记为过期 —— 不欠费、不停机中间态。
   * 由定时任务对所有 expiresAt <= now 且 autoRenew 的订阅调用。
   */
  renew(
    tenant: string,
    userId: number,
    now = Date.now()
  ): { ok: boolean; reason?: 'no_subscription' | 'plan_gone' | 'insufficient_balance' } {
    const sub = this.getSubscription(tenant, userId)
    if (!sub) return { ok: false, reason: 'no_subscription' }
    const plan = this.getPlan(tenant, sub.planId)
    if (!plan || !plan.enabled) {
      this.putSubscription(tenant, { ...sub, status: 'expired' }, now)
      return { ok: false, reason: 'plan_gone' }
    }

    const r = this.mutate(tenant, {
      userId,
      kind: 'renew',
      amountCents: -plan.priceCents,
      refType: 'plan',
      refId: plan.id,
      note: `${plan.name} 自动续费`,
      now
    })
    if (!r.ok) {
      this.putSubscription(tenant, { ...sub, status: 'expired' }, now)
      return { ok: false, reason: 'insufficient_balance' }
    }

    this.putSubscription(
      tenant,
      {
        ...sub,
        expiresAt: renewExpiry(sub.expiresAt, now, planPeriod(plan)),
        status: 'active'
      },
      now
    )
    return { ok: true }
  }

  /** 标记过期（定时任务对未开自动续费的到期订阅调用） */
  expireIfDue(tenant: string, userId: number, now = Date.now()): boolean {
    const sub = this.getSubscription(tenant, userId)
    if (!sub || sub.status !== 'active' || sub.expiresAt > now) return false
    this.putSubscription(tenant, { ...sub, status: 'expired' }, now)
    return true
  }

  /** 当前可用的账号数上限；无有效订阅时为 0 */
  accountQuota(tenant: string, userId: number, now = Date.now()): number {
    const sub = this.getSubscription(tenant, userId)
    if (!sub || sub.status !== 'active' || sub.expiresAt <= now) return 0
    return this.getPlan(tenant, sub.planId)?.maxAccounts ?? 0
  }

  checkAccountQuota(
    tenant: string,
    userId: number,
    currentAccounts: number,
    now = Date.now()
  ): ReturnType<typeof accountQuotaState> {
    return accountQuotaState(currentAccounts, this.accountQuota(tenant, userId, now))
  }

  // ── 积分 ──

  /** 用余额兑换积分 */
  exchangeCredits(
    tenant: string,
    userId: number,
    cents: Cents,
    rate: CreditRate,
    now = Date.now()
  ): MutateResult {
    const amount = Math.max(0, Math.round(cents))
    const credits = Math.floor((amount / 100) * Math.max(1, rate.creditsPerUsd))
    return this.mutate(tenant, {
      userId,
      kind: 'credit_exchange',
      amountCents: -amount,
      creditsDelta: credits,
      note: `${amount} 分兑换 ${credits} 积分`,
      now
    })
  }

  /**
   * 扣模型积分，必要时自动从余额补足。
   * 判断逻辑全在纯函数 deductCredits 里，这里只负责落库。
   */
  chargeCredits(
    tenant: string,
    userId: number,
    cost: number,
    opts: { autoTopUp: boolean; rate: CreditRate; refId?: string; note?: string; now?: number }
  ): { ok: boolean; reason?: string; balance: Balance } {
    const now = opts.now ?? Date.now()
    const current = this.getBalance(tenant, userId)
    const plan = deductCredits({
      credits: current.credits,
      balanceCents: current.balanceCents,
      cost,
      autoTopUp: opts.autoTopUp,
      rate: opts.rate
    })
    if (!plan.ok) return { ok: false, reason: plan.reason, balance: current }
    if (cost <= 0) return { ok: true, balance: current }

    // 补足与扣减合成一条流水：用户看到的是"这次调用花了多少"，拆两条反而费解
    const r = this.mutate(tenant, {
      userId,
      kind: 'model_usage',
      amountCents: -plan.centsUsed,
      creditsDelta: -plan.creditsUsed,
      refType: 'model',
      refId: opts.refId,
      note: opts.note,
      now
    })
    return { ok: r.ok, balance: r.balance }
  }
}

function toPlan(r: typeof plans.$inferSelect): Plan {
  return {
    id: r.id,
    name: r.name,
    priceCents: r.priceCents,
    periodUnit: r.periodUnit as PeriodUnit,
    periodCount: r.periodCount,
    maxAccounts: r.maxAccounts,
    enabled: r.enabled === 1,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt
  }
}

function planPeriod(p: Plan): PlanPeriod {
  return { unit: p.periodUnit, count: p.periodCount }
}

function toSnapshot(p: Plan): PlanSnapshot {
  return { priceCents: p.priceCents, period: planPeriod(p) }
}
