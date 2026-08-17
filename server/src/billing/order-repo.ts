import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { orders } from '../schema.ts'
import type { BillingRepo } from './billing-repo.ts'
import { computeFee, convertFromUsd, type Cents, type FeeConfig } from './money.ts'

export type OrderKind = 'topup' | 'plan'
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

export interface Order {
  id: string
  userId: number
  kind: OrderKind
  planId?: string
  amountCents: Cents
  feeCents: Cents
  payableCents: Cents
  currency: string
  lockedRate: number
  payableLocal: number
  channelId?: string
  channelType?: string
  status: OrderStatus
  tradeNo?: string
  paidAt?: number
  createdAt: number
  expiresAt: number
}

export interface CreateOrderInput {
  userId: number
  kind: OrderKind
  /** 商品价值（美分 USD） */
  amountCents: Cents
  planId?: string
  channelId: string
  channelType: string
  fee: FeeConfig
  /** 收款币种与汇率；USD 直收时 rate = 1 */
  currency: string
  rate: number
  decimals?: number
  /** 订单有效期（毫秒），默认 30 分钟 */
  ttlMs?: number
  now?: number
}

export type SettleResult =
  | { ok: true; order: Order; alreadyPaid: boolean }
  | {
      ok: false
      reason: 'not_found' | 'amount_mismatch' | 'expired' | 'not_pending'
      order?: Order
    }

const DEFAULT_TTL = 30 * 60 * 1000

/**
 * 支付订单。
 *
 * 这里最要紧的是**幂等**：支付通道普遍会重复推送回调（网络重试、
 * 人工补发都很常见）。如果每次回调都入一次账，用户充一次钱能到账好几次。
 * 所以 settle() 用「状态条件更新」实现幂等 —— 只有把订单从 pending
 * 改成 paid 的那一次（changes > 0）才真正入账，重复回调直接返回
 * alreadyPaid，不再动余额。
 */
export class OrderRepo {
  private readonly db: Db
  private readonly billing: BillingRepo

  constructor(db: Db, billing: BillingRepo) {
    this.db = db
    this.billing = billing
  }

  /** 商户订单号：时间前缀便于人工排查，随机后缀防猜测 */
  static newOrderId(now = Date.now()): string {
    return `${now.toString(36)}${randomBytes(6).toString('hex')}`
  }

  create(tenant: string, input: CreateOrderInput): Order {
    const now = input.now ?? Date.now()
    const breakdown = computeFee(input.amountCents, input.fee)
    const payableLocal =
      input.currency === 'USD' && input.rate === 1
        ? breakdown.payable
        : convertFromUsd(breakdown.payable, {
            currency: input.currency,
            rate: input.rate,
            decimals: input.decimals
          })

    const row = {
      tenant,
      id: OrderRepo.newOrderId(now),
      userId: input.userId,
      kind: input.kind,
      planId: input.planId ?? null,
      amountCents: breakdown.amount,
      feeCents: breakdown.fee,
      payableCents: breakdown.payable,
      currency: input.currency,
      // 汇率存字符串：浮点在存取往返中会失真，而这是对账依据
      lockedRate: String(input.rate),
      payableLocal,
      channelId: input.channelId,
      channelType: input.channelType,
      status: 'pending',
      tradeNo: null,
      paidAt: null,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TTL)
    }
    this.db.insert(orders).values(row).run()
    return toOrder(row as typeof orders.$inferSelect)
  }

  get(tenant: string, id: string): Order | null {
    const r = this.db
      .select()
      .from(orders)
      .where(and(eq(orders.tenant, tenant), eq(orders.id, id)))
      .get()
    return r ? toOrder(r) : null
  }

  listByUser(tenant: string, userId: number, limit = 50): Order[] {
    return this.db
      .select()
      .from(orders)
      .where(and(eq(orders.tenant, tenant), eq(orders.userId, userId)))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .all()
      .map(toOrder)
  }

  /** 管理后台：全租户订单列表（可按状态过滤，手动补单用） */
  listAll(tenant: string, status?: string, limit = 100): Order[] {
    const conds = [eq(orders.tenant, tenant)]
    if (status) conds.push(eq(orders.status, status))
    return this.db
      .select()
      .from(orders)
      .where(and(...conds))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .all()
      .map(toOrder)
  }

  /**
   * 结算一笔支付回调。
   *
   * @param paidAmountLocal 通道回报的实付金额（目标币种最小单位）；
   *        传入才校验。**只验签不验金额是典型漏洞** —— 攻击者用一笔
   *        小额真实回调就能把大额订单标记成已支付。
   */
  settle(
    tenant: string,
    orderId: string,
    opts: { tradeNo?: string; paidAmountLocal?: number; now?: number; allowUnderpay?: boolean }
  ): SettleResult {
    const now = opts.now ?? Date.now()
    const existing = this.get(tenant, orderId)
    if (!existing) return { ok: false, reason: 'not_found' }

    // 重复回调：已支付的直接返回，不再入账
    if (existing.status === 'paid') return { ok: true, order: existing, alreadyPaid: true }
    if (existing.status !== 'pending') {
      return { ok: false, reason: 'not_pending', order: existing }
    }
    if (existing.expiresAt <= now) {
      this.markExpired(tenant, orderId, now)
      return { ok: false, reason: 'expired', order: existing }
    }
    if (
      opts.paidAmountLocal !== undefined &&
      !opts.allowUnderpay &&
      opts.paidAmountLocal < existing.payableLocal
    ) {
      return { ok: false, reason: 'amount_mismatch', order: existing }
    }

    // 幂等的关键：带 status='pending' 条件更新。并发的两个回调里
    // 只有一个能把状态改掉，另一个 changes 为 0，不会重复入账。
    const res = this.db
      .update(orders)
      .set({ status: 'paid', tradeNo: opts.tradeNo ?? null, paidAt: now })
      .where(
        and(eq(orders.tenant, tenant), eq(orders.id, orderId), eq(orders.status, 'pending'))
      )
      .run()

    if (res.changes === 0) {
      const after = this.get(tenant, orderId)
      return after
        ? { ok: true, order: after, alreadyPaid: true }
        : { ok: false, reason: 'not_found' }
    }

    // 入账按 amountCents（商品价值）而不是 payableCents ——
    // 客户承担的手续费不属于用户资产，不能充进余额
    this.billing.mutate(tenant, {
      userId: existing.userId,
      kind: 'topup',
      amountCents: existing.amountCents,
      refType: 'order',
      refId: orderId,
      note: existing.kind === 'plan' ? '购买套餐充值' : '余额充值',
      now
    })

    const order = this.get(tenant, orderId)!
    return { ok: true, order, alreadyPaid: false }
  }

  markExpired(tenant: string, orderId: string, now = Date.now()): boolean {
    const res = this.db
      .update(orders)
      .set({ status: 'expired' })
      .where(
        and(eq(orders.tenant, tenant), eq(orders.id, orderId), eq(orders.status, 'pending'))
      )
      .run()
    void now
    return res.changes > 0
  }

  /** 批量把超时未付的订单置为过期（定时任务调用） */
  expireStale(tenant: string, now = Date.now()): number {
    const res = this.db
      .update(orders)
      .set({ status: 'expired' })
      .where(
        and(
          eq(orders.tenant, tenant),
          eq(orders.status, 'pending'),
          sql`${orders.expiresAt} <= ${now}`
        )
      )
      .run()
    return res.changes
  }
}

function toOrder(r: typeof orders.$inferSelect): Order {
  return {
    id: r.id,
    userId: r.userId,
    kind: r.kind as OrderKind,
    planId: r.planId ?? undefined,
    amountCents: r.amountCents,
    feeCents: r.feeCents,
    payableCents: r.payableCents,
    currency: r.currency,
    lockedRate: Number(r.lockedRate),
    payableLocal: r.payableLocal,
    channelId: r.channelId ?? undefined,
    channelType: r.channelType ?? undefined,
    status: r.status as OrderStatus,
    tradeNo: r.tradeNo ?? undefined,
    paidAt: r.paidAt ?? undefined,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt
  }
}
