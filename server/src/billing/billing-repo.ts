import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import {
  balances,
  commissionLedger,
  commissionSettings,
  entitlementLedger,
  entitlements,
  ledger,
  plans,
  referrals,
  subscriptions,
  translationUsage
} from '../schema.ts'
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
  /** 可同时登录的设备数上限；0 = 不限 */
  maxDevices: number
  tier: MembershipTier
  includedCharacters: number
  /** Markdown 描述；空 = 不显示 */
  description: string
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
  maxDevices?: number
  tier?: MembershipTier
  includedCharacters?: number
  description?: string
  enabled?: boolean
  sortOrder?: number
}

export type MembershipTier = 'free' | 'vip1' | 'vip2' | 'vip3' | 'custom'
export const MEMBERSHIP_TIERS: MembershipTier[] = ['free', 'vip1', 'vip2', 'vip3', 'custom']

export interface Entitlements {
  userId: number
  characters: number
  bonusPorts: number
}

export type EntitlementKind =
  | 'admin_gift'
  | 'character_purchase'
  | 'plan_grant'
  | 'translation_usage'
  | 'adjust'

export interface EntitlementEntry {
  id: number
  kind: EntitlementKind
  charactersDelta: number
  portsDelta: number
  charactersAfter: number
  portsAfter: number
  refType?: string
  refId?: string
  note?: string
  createdAt: number
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
  | 'character_purchase'
  | 'model_usage'
  | 'commission'
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
  /** 消费返佣基数（美分）；模型积分消费等 amountCents=0 的场景显式传入。 */
  commissionBaseCents?: Cents
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
      maxDevices: Math.max(0, Math.floor(input.maxDevices ?? 0)),
      tier: MEMBERSHIP_TIERS.includes(input.tier ?? 'custom') ? (input.tier ?? 'custom') : 'custom',
      includedCharacters: Math.max(0, Math.floor(input.includedCharacters ?? 0)),
      description: (input.description ?? '').slice(0, 4000),
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
    if (patch.maxDevices !== undefined) set.maxDevices = Math.max(0, Math.floor(patch.maxDevices))
    if (patch.tier !== undefined && MEMBERSHIP_TIERS.includes(patch.tier)) set.tier = patch.tier
    if (patch.includedCharacters !== undefined) {
      set.includedCharacters = Math.max(0, Math.floor(patch.includedCharacters))
    }
    if (patch.description !== undefined) set.description = patch.description.slice(0, 4000)
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

  /** 只允许删除从未被订阅引用的套餐；有历史关系时应停用。 */
  deletePlan(tenant: string, id: string): { ok: boolean; reason?: 'in_use' | 'not_found' } {
    const used = this.db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(and(eq(subscriptions.tenant, tenant), eq(subscriptions.planId, id)))
      .get()
    if (used) return { ok: false, reason: 'in_use' }
    const res = this.db
      .delete(plans)
      .where(and(eq(plans.tenant, tenant), eq(plans.id, id)))
      .run()
    return res.changes > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
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

  // ── 翻译字符与额外端口 ──

  getEntitlements(tenant: string, userId: number): Entitlements {
    const row = this.db
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.tenant, tenant), eq(entitlements.userId, userId)))
      .get()
    return row
      ? { userId, characters: row.characters, bonusPorts: row.bonusPorts }
      : { userId, characters: 0, bonusPorts: 0 }
  }

  mutateEntitlements(
    tenant: string,
    input: {
      userId: number
      kind: EntitlementKind
      charactersDelta?: number
      portsDelta?: number
      refType?: string
      refId?: string
      note?: string
      now?: number
    }
  ): { ok: boolean; entitlements: Entitlements; reason?: 'insufficient_characters' | 'insufficient_ports' } {
    const now = input.now ?? Date.now()
    const charactersDelta = Math.round(Number(input.charactersDelta ?? 0))
    const portsDelta = Math.round(Number(input.portsDelta ?? 0))
    return this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(entitlements)
        .where(and(eq(entitlements.tenant, tenant), eq(entitlements.userId, input.userId)))
        .get()
      const characters = current?.characters ?? 0
      const bonusPorts = current?.bonusPorts ?? 0
      const nextCharacters = characters + charactersDelta
      const nextPorts = bonusPorts + portsDelta
      if (nextCharacters < 0) {
        return {
          ok: false as const,
          entitlements: { userId: input.userId, characters, bonusPorts },
          reason: 'insufficient_characters' as const
        }
      }
      if (nextPorts < 0) {
        return {
          ok: false as const,
          entitlements: { userId: input.userId, characters, bonusPorts },
          reason: 'insufficient_ports' as const
        }
      }
      tx.insert(entitlements)
        .values({ tenant, userId: input.userId, characters: nextCharacters, bonusPorts: nextPorts, updatedAt: now })
        .onConflictDoUpdate({
          target: [entitlements.tenant, entitlements.userId],
          set: {
            characters: sql`excluded.characters`,
            bonusPorts: sql`excluded.bonus_ports`,
            updatedAt: sql`excluded.updated_at`
          }
        })
        .run()
      tx.insert(entitlementLedger)
        .values({
          tenant,
          userId: input.userId,
          kind: input.kind,
          charactersDelta,
          portsDelta,
          charactersAfter: nextCharacters,
          portsAfter: nextPorts,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          note: input.note ?? null,
          createdAt: now
        })
        .run()
      return {
        ok: true as const,
        entitlements: { userId: input.userId, characters: nextCharacters, bonusPorts: nextPorts }
      }
    })
  }

  listEntitlementLedger(tenant: string, userId: number, limit = 100): EntitlementEntry[] {
    return this.db
      .select()
      .from(entitlementLedger)
      .where(and(eq(entitlementLedger.tenant, tenant), eq(entitlementLedger.userId, userId)))
      .orderBy(desc(entitlementLedger.createdAt), desc(entitlementLedger.id))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        kind: row.kind as EntitlementKind,
        charactersDelta: row.charactersDelta,
        portsDelta: row.portsDelta,
        charactersAfter: row.charactersAfter,
        portsAfter: row.portsAfter,
        refType: row.refType ?? undefined,
        refId: row.refId ?? undefined,
        note: row.note ?? undefined,
        createdAt: row.createdAt
      }))
  }

  chargeTranslation(
    tenant: string,
    input: {
      userId: number
      actorUserId: number
      requestId: string
      characters: number
      engine?: string
      channel?: string
      accountId?: string
      direction?: string
      now?: number
    }
  ): { ok: boolean; charged: number; remaining: number; duplicate?: boolean; reason?: 'insufficient_characters' } {
    const characters = Math.max(0, Math.floor(Number(input.characters)))
    const now = input.now ?? Date.now()
    return this.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(translationUsage)
        .where(and(
          eq(translationUsage.tenant, tenant),
          eq(translationUsage.userId, input.userId),
          eq(translationUsage.requestId, input.requestId)
        ))
        .get()
      if (previous) {
        const current = tx
          .select()
          .from(entitlements)
          .where(and(eq(entitlements.tenant, tenant), eq(entitlements.userId, input.userId)))
          .get()
        return { ok: true as const, charged: previous.sourceCharacters, remaining: current?.characters ?? 0, duplicate: true }
      }
      const current = tx
        .select()
        .from(entitlements)
        .where(and(eq(entitlements.tenant, tenant), eq(entitlements.userId, input.userId)))
        .get()
      const available = current?.characters ?? 0
      if (characters <= 0) return { ok: true as const, charged: 0, remaining: available }
      if (available < characters) {
        return { ok: false as const, charged: 0, remaining: available, reason: 'insufficient_characters' as const }
      }
      const bonusPorts = current?.bonusPorts ?? 0
      const remaining = available - characters
      tx.insert(entitlements)
        .values({ tenant, userId: input.userId, characters: remaining, bonusPorts, updatedAt: now })
        .onConflictDoUpdate({
          target: [entitlements.tenant, entitlements.userId],
          set: { characters: sql`excluded.characters`, updatedAt: sql`excluded.updated_at` }
        })
        .run()
      tx.insert(entitlementLedger)
        .values({
          tenant,
          userId: input.userId,
          kind: 'translation_usage',
          charactersDelta: -characters,
          portsDelta: 0,
          charactersAfter: remaining,
          portsAfter: bonusPorts,
          refType: 'translation',
          refId: input.requestId,
          note: `${input.engine || 'unknown'} · ${input.direction || 'unknown'}`,
          createdAt: now
        })
        .run()
      tx.insert(translationUsage)
        .values({
          tenant,
          requestId: input.requestId,
          userId: input.userId,
          actorUserId: input.actorUserId,
          engine: (input.engine || 'unknown').slice(0, 60),
          channel: (input.channel || '').slice(0, 40),
          accountId: (input.accountId || '').slice(0, 160),
          direction: (input.direction || 'unknown').slice(0, 20),
          sourceCharacters: characters,
          createdAt: now
        })
        .run()
      return { ok: true as const, charged: characters, remaining }
    })
  }

  translationUsageSummary(tenant: string, userId?: number): {
    totalCharacters: number
    totalTranslations: number
    byEngine: Array<{ engine: string; characters: number; calls: number }>
    byChannel: Array<{ channel: string; characters: number; calls: number }>
    recent: Array<{ userId: number; requestId: string; engine: string; channel: string; direction: string; sourceCharacters: number; createdAt: number }>
  } {
    const where = userId === undefined
      ? eq(translationUsage.tenant, tenant)
      : and(eq(translationUsage.tenant, tenant), eq(translationUsage.userId, userId))
    const characterSum = sql<number>`coalesce(sum(${translationUsage.sourceCharacters}), 0)`
    const callCount = sql<number>`count(*)`
    const totals = this.db
      .select({ characters: characterSum, calls: callCount })
      .from(translationUsage)
      .where(where)
      .get()
    const byEngine = this.db
      .select({ engine: translationUsage.engine, characters: characterSum, calls: callCount })
      .from(translationUsage)
      .where(where)
      .groupBy(translationUsage.engine)
      .orderBy(desc(characterSum))
      .all()
      .map((row) => ({ engine: row.engine || 'unknown', characters: Number(row.characters), calls: Number(row.calls) }))
    const byChannel = this.db
      .select({ channel: translationUsage.channel, characters: characterSum, calls: callCount })
      .from(translationUsage)
      .where(where)
      .groupBy(translationUsage.channel)
      .orderBy(desc(characterSum))
      .all()
      .map((row) => ({ channel: row.channel || 'unknown', characters: Number(row.characters), calls: Number(row.calls) }))
    const recent = this.db
      .select({
        userId: translationUsage.userId,
        requestId: translationUsage.requestId,
        engine: translationUsage.engine,
        channel: translationUsage.channel,
        direction: translationUsage.direction,
        sourceCharacters: translationUsage.sourceCharacters,
        createdAt: translationUsage.createdAt
      })
      .from(translationUsage)
      .where(where)
      .orderBy(desc(translationUsage.createdAt))
      .limit(100)
      .all()
    return {
      totalCharacters: Number(totals?.characters ?? 0),
      totalTranslations: Number(totals?.calls ?? 0),
      byEngine,
      byChannel,
      recent
    }
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

      const ledgerResult = tx.insert(ledger)
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

      // 邀请返佣必须与原始充值/消费在同一事务完成：要么两边一起成功，要么一起回滚。
      // 管理员调账、退款、积分兑换和返佣本身不参与，避免循环返佣或重复计算。
      const excludedSpendKinds: LedgerKind[] = [
        'adjust',
        'proration_refund',
        'credit_exchange',
        'commission'
      ]
      const eventType = input.kind === 'topup' && amount > 0
        ? 'topup'
        : !excludedSpendKinds.includes(input.kind) && (amount < 0 || (input.commissionBaseCents ?? 0) > 0)
          ? 'spend'
          : null
      const baseCents = Math.max(0, Math.round(input.commissionBaseCents ?? Math.abs(amount)))
      if (eventType && baseCents > 0) {
        const relation = tx
          .select()
          .from(referrals)
          .where(and(eq(referrals.tenant, tenant), eq(referrals.inviteeUserId, input.userId)))
          .get()
        const rateBps = tx
          .select()
          .from(commissionSettings)
          .where(eq(commissionSettings.tenant, tenant))
          .get()?.rateBps ?? 0
        const commissionCents = Math.floor((baseCents * Math.max(0, Math.min(10_000, rateBps))) / 10_000)
        if (relation && commissionCents > 0) {
          const sourceLedgerId = Number(ledgerResult.lastInsertRowid)
          const commissionInsert = tx
            .insert(commissionLedger)
            .values({
              tenant,
              inviterUserId: relation.inviterUserId,
              inviteeUserId: input.userId,
              sourceLedgerId,
              eventType,
              baseCents,
              rateBps,
              commissionCents,
              createdAt: now
            })
            .onConflictDoNothing({ target: [commissionLedger.tenant, commissionLedger.sourceLedgerId] })
            .run()
          if (commissionInsert.changes > 0) {
            const inviterBalance = tx
              .select()
              .from(balances)
              .where(and(eq(balances.tenant, tenant), eq(balances.userId, relation.inviterUserId)))
              .get()
            const inviterNextBalance = (inviterBalance?.balanceCents ?? 0) + commissionCents
            const inviterCredits = inviterBalance?.credits ?? 0
            tx.insert(balances)
              .values({
                tenant,
                userId: relation.inviterUserId,
                balanceCents: inviterNextBalance,
                credits: inviterCredits,
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
            tx.insert(ledger).values({
              tenant,
              userId: relation.inviterUserId,
              kind: 'commission',
              amountCents: commissionCents,
              creditsDelta: 0,
              balanceAfter: inviterNextBalance,
              creditsAfter: inviterCredits,
              refType: 'commission',
              refId: String(sourceLedgerId),
              note: `${eventType === 'topup' ? '充值' : '消费'}邀请返佣`,
              createdAt: now
            }).run()
          }
        }
      }

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

  /** 管理后台直接开通/调整套餐；不扣余额，但保留订阅状态与到期时间。 */
  setSubscriptionByAdmin(
    tenant: string,
    userId: number,
    input: { planId: string; expiresAt?: number; autoRenew?: boolean; status?: string },
    now = Date.now()
  ): Subscription | null {
    const plan = this.getPlan(tenant, input.planId)
    if (!plan) return null
    const current = this.getSubscription(tenant, userId)
    const expiresAt = Number.isFinite(input.expiresAt) && Number(input.expiresAt) > now
      ? Number(input.expiresAt)
      : renewExpiry(now, now, planPeriod(plan))
    const subscription: Subscription = {
      userId,
      planId: plan.id,
      startAt: current?.startAt ?? now,
      expiresAt,
      autoRenew: input.autoRenew ?? current?.autoRenew ?? false,
      status: input.status === 'cancelled' || input.status === 'expired' ? input.status : 'active'
    }
    this.putSubscription(tenant, subscription, now)
    const startsNewPaidPeriod = subscription.status === 'active'
      && (!current || current.planId !== plan.id || current.status !== 'active' || current.expiresAt <= now)
    if (startsNewPaidPeriod && plan.includedCharacters > 0) {
      this.mutateEntitlements(tenant, {
        userId,
        kind: 'plan_grant',
        charactersDelta: plan.includedCharacters,
        refType: 'plan',
        refId: plan.id,
        note: `${plan.name} 套餐赠送字符`,
        now
      })
    }
    return subscription
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
    | { ok: false; reason: 'plan_not_found' | 'plan_disabled' | 'insufficient_balance' | 'already_subscribed' } {
    const newPlan = this.getPlan(tenant, newPlanId)
    if (!newPlan) return { ok: false, reason: 'plan_not_found' }
    if (!newPlan.enabled) return { ok: false, reason: 'plan_disabled' }

    const current = this.getSubscription(tenant, userId)
    const hadActiveSubscription = Boolean(
      current && current.status === 'active' && current.expiresAt > now
    )
    // 当前套餐由自动续费延长；禁止重复购买同一有效套餐，避免反复领取赠送字符。
    if (hadActiveSubscription && current?.planId === newPlanId) {
      return { ok: false, reason: 'already_subscribed' }
    }
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
    // 有效期内升降级保留已有字符，但不重复发放新套餐赠送；新购或过期后再购才发放。
    if (!hadActiveSubscription && newPlan.includedCharacters > 0) {
      this.mutateEntitlements(tenant, {
        userId,
        kind: 'plan_grant',
        charactersDelta: newPlan.includedCharacters,
        refType: 'plan',
        refId: newPlan.id,
        note: `${newPlan.name} 套餐赠送字符`,
        now
      })
    }

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
    if (plan.includedCharacters > 0) {
      this.mutateEntitlements(tenant, {
        userId,
        kind: 'plan_grant',
        charactersDelta: plan.includedCharacters,
        refType: 'plan',
        refId: plan.id,
        note: `${plan.name} 续费赠送字符`,
        now
      })
    }
    return { ok: true }
  }

  /** 标记过期（定时任务对未开自动续费的到期订阅调用） */
  expireIfDue(tenant: string, userId: number, now = Date.now()): boolean {
    const sub = this.getSubscription(tenant, userId)
    if (!sub || sub.status !== 'active' || sub.expiresAt > now) return false
    this.putSubscription(tenant, { ...sub, status: 'expired' }, now)
    return true
  }

  /** 当前可用的端口数上限；免费用户永久 10 个，0 表示 VIP3 不限。 */
  accountQuota(tenant: string, userId: number, now = Date.now()): number {
    const sub = this.getSubscription(tenant, userId)
    const bonus = this.getEntitlements(tenant, userId).bonusPorts
    if (!sub || sub.status !== 'active' || sub.expiresAt <= now) return 10 + bonus
    const base = this.getPlan(tenant, sub.planId)?.maxAccounts ?? 10
    return base === 0 ? 0 : base + bonus
  }

  /**
   * 当前设备数上限；0 = 不限（无有效订阅或套餐未设上限都视为不限）。
   * 与 accountQuota 语义不同：设备上限缺省是「不限」而非「禁止」——
   * 没订阅的用户仍要能登录，只是无法添加平台账号。
   */
  deviceQuota(tenant: string, userId: number, now = Date.now()): number {
    const sub = this.getSubscription(tenant, userId)
    if (!sub || sub.status !== 'active' || sub.expiresAt <= now) return 0
    return this.getPlan(tenant, sub.planId)?.maxDevices ?? 0
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

  /** 用余额购买翻译字符；1 美元兑换数量由管理员配置。 */
  purchaseCharacters(
    tenant: string,
    userId: number,
    cents: Cents,
    charactersPerUsd: number,
    now = Date.now()
  ): { ok: boolean; characters: number; balance: Balance; entitlements: Entitlements; reason?: string } {
    const amount = Math.max(0, Math.round(cents))
    const characters = Math.floor((amount / 100) * Math.max(1, Math.floor(charactersPerUsd)))
    const before = this.getBalance(tenant, userId)
    const currentEntitlements = this.getEntitlements(tenant, userId)
    if (amount <= 0 || characters <= 0) {
      return { ok: false, reason: 'invalid_amount', characters: 0, balance: before, entitlements: currentEntitlements }
    }
    const charged = this.mutate(tenant, {
      userId,
      kind: 'character_purchase',
      amountCents: -amount,
      refType: 'characters',
      note: `${amount} 分兑换 ${characters} 翻译字符`,
      now
    })
    if (!charged.ok) {
      return { ok: false, reason: charged.reason, characters: 0, balance: charged.balance, entitlements: currentEntitlements }
    }
    const granted = this.mutateEntitlements(tenant, {
      userId,
      kind: 'character_purchase',
      charactersDelta: characters,
      refType: 'balance',
      note: `${amount} 分兑换 ${characters} 翻译字符`,
      now
    })
    if (!granted.ok) {
      this.mutate(tenant, {
        userId,
        kind: 'adjust',
        amountCents: amount,
        refType: 'characters',
        note: '字符入账失败，自动退回余额',
        now
      })
      return { ok: false, reason: granted.reason, characters: 0, balance: this.getBalance(tenant, userId), entitlements: currentEntitlements }
    }
    return { ok: true, characters, balance: charged.balance, entitlements: granted.entitlements }
  }

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
      // 即便本次完全使用已有积分、没有直接扣余额，也按积分的美元价值返佣。
      commissionBaseCents: Math.ceil((Math.max(0, Math.round(cost)) * 100) / Math.max(1, opts.rate.creditsPerUsd)),
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
    maxDevices: r.maxDevices,
    tier: (MEMBERSHIP_TIERS.includes(r.tier as MembershipTier) ? r.tier : 'custom') as MembershipTier,
    includedCharacters: r.includedCharacters,
    description: r.description,
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
