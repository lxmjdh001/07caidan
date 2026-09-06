import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import {
  clientUsers,
  commissionLedger,
  commissionSettings,
  inviteCodes,
  referrals
} from './schema.ts'

export interface InviteCodeView {
  code: string
  enabled: boolean
  maxUses: number
  usedCount: number
  expiresAt?: number
  createdAt: number
}

export interface ReferralView {
  userId: number
  email: string
  inviterUserId?: number
  inviterEmail?: string
  inviteCode: string
  registeredAt: number
  commissionCents: number
}

export interface CommissionView {
  id: number
  inviterUserId: number
  inviteeUserId: number
  inviterEmail?: string
  inviteeEmail?: string
  eventType: 'topup' | 'spend'
  baseCents: number
  rateBps: number
  commissionCents: number
  createdAt: number
}

function cleanCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '')
}

function maskedEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!domain) return email
  return `${(name ?? '').slice(0, 2)}${'*'.repeat(Math.max(2, Math.min(6, (name?.length ?? 0) - 2)))}@${domain}`
}

/** 邀请关系、邀请码和佣金报表；真正的资金入账在 BillingRepo 的同一事务内完成。 */
export class InviteRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  normalizeCode(value: string): string {
    return cleanCode(value)
  }

  /** 注册前快速校验；注册事务内还会再次校验，避免并发超用。 */
  validateCode(tenant: string, value: string, now = Date.now()): { ok: true; code: string } | { ok: false; error: string } {
    const code = cleanCode(value)
    if (!/^[A-Z0-9]{6,24}$/.test(code)) return { ok: false, error: '邀请码格式不正确' }
    const row = this.db.select().from(inviteCodes).where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.code, code))).get()
    if (!row || row.enabled !== 1) return { ok: false, error: '邀请码不存在或已停用' }
    if (row.expiresAt != null && row.expiresAt <= now) return { ok: false, error: '邀请码已过期' }
    if (row.maxUses > 0 && row.usedCount >= row.maxUses) return { ok: false, error: '邀请码使用次数已满' }
    return { ok: true, code }
  }

  createCode(
    tenant: string,
    inviterUserId: number,
    input: { code?: string; maxUses?: number; expiresAt?: number }
  ): { ok: true; invite: InviteCodeView } | { ok: false; error: string } {
    const custom = input.code ? cleanCode(input.code) : ''
    if (custom && !/^[A-Z0-9]{6,24}$/.test(custom)) {
      return { ok: false, error: '邀请码只能包含 6-24 位字母和数字' }
    }
    const maxUses = Math.max(0, Math.min(1_000_000, Math.floor(Number(input.maxUses) || 0)))
    const expiresAt = Number(input.expiresAt) > Date.now() ? Math.floor(Number(input.expiresAt)) : null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = custom || `WZZ${randomBytes(5).toString('hex').toUpperCase()}`
      const now = Date.now()
      try {
        const row = {
          tenant,
          code,
          inviterUserId,
          enabled: 1,
          maxUses,
          usedCount: 0,
          expiresAt,
          createdAt: now,
          updatedAt: now
        }
        this.db.insert(inviteCodes).values(row).run()
        return { ok: true, invite: toInvite(row) }
      } catch {
        if (custom) return { ok: false, error: '该邀请码已被使用' }
      }
    }
    return { ok: false, error: '生成邀请码失败，请重试' }
  }

  ensurePersonalCode(tenant: string, inviterUserId: number): InviteCodeView {
    const existing = this.db
      .select()
      .from(inviteCodes)
      .where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.inviterUserId, inviterUserId)))
      .orderBy(inviteCodes.createdAt)
      .get()
    if (existing) return toInvite(existing)
    const created = this.createCode(tenant, inviterUserId, {})
    if (!created.ok) throw new Error(created.error)
    return created.invite
  }

  listCodes(tenant: string, inviterUserId: number): InviteCodeView[] {
    return this.db
      .select()
      .from(inviteCodes)
      .where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.inviterUserId, inviterUserId)))
      .orderBy(desc(inviteCodes.createdAt))
      .all()
      .map(toInvite)
  }

  setEnabled(tenant: string, inviterUserId: number, code: string, enabled: boolean): boolean {
    const res = this.db
      .update(inviteCodes)
      .set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.inviterUserId, inviterUserId), eq(inviteCodes.code, cleanCode(code))))
      .run()
    return res.changes > 0
  }

  getRateBps(tenant: string): number {
    return this.db.select().from(commissionSettings).where(eq(commissionSettings.tenant, tenant)).get()?.rateBps ?? 0
  }

  setRateBps(tenant: string, rateBps: number): number {
    const value = Math.max(0, Math.min(10_000, Math.round(rateBps)))
    this.db.insert(commissionSettings).values({ tenant, rateBps: value, updatedAt: Date.now() }).onConflictDoUpdate({
      target: commissionSettings.tenant,
      set: { rateBps: value, updatedAt: Date.now() }
    }).run()
    return value
  }

  listReferrals(tenant: string, inviterUserId: number, admin = false): ReferralView[] {
    const rows = this.db
      .select({
        userId: referrals.inviteeUserId,
        email: clientUsers.email,
        inviteCode: referrals.inviteCode,
        registeredAt: referrals.createdAt,
        commissionCents: sql<number>`coalesce(sum(${commissionLedger.commissionCents}), 0)`
      })
      .from(referrals)
      .innerJoin(clientUsers, eq(clientUsers.id, referrals.inviteeUserId))
      .leftJoin(
        commissionLedger,
        and(eq(commissionLedger.tenant, referrals.tenant), eq(commissionLedger.inviteeUserId, referrals.inviteeUserId))
      )
      .where(and(eq(referrals.tenant, tenant), eq(referrals.inviterUserId, inviterUserId)))
      .groupBy(referrals.inviteeUserId, clientUsers.email, referrals.inviteCode, referrals.createdAt)
      .orderBy(desc(referrals.createdAt))
      .all()
    return rows.map((r) => ({ ...r, email: admin ? r.email : maskedEmail(r.email), commissionCents: Number(r.commissionCents) || 0 }))
  }

  listCommissions(tenant: string, inviterUserId?: number, limit = 500): CommissionView[] {
    // 两次关联同一张表在 drizzle 的无 alias 场景会产生歧义；先查流水，再批量映射邮箱。
    const rows = this.db
      .select()
      .from(commissionLedger)
      .where(inviterUserId === undefined ? eq(commissionLedger.tenant, tenant) : and(eq(commissionLedger.tenant, tenant), eq(commissionLedger.inviterUserId, inviterUserId)))
      .orderBy(desc(commissionLedger.createdAt), desc(commissionLedger.id))
      .limit(Math.max(1, Math.min(2000, limit)))
      .all()
    const emails = new Map(this.db.select({ id: clientUsers.id, email: clientUsers.email }).from(clientUsers).where(eq(clientUsers.tenant, tenant)).all().map((u) => [u.id, u.email]))
    return rows.map((r) => ({
      id: r.id,
      inviterUserId: r.inviterUserId,
      inviteeUserId: r.inviteeUserId,
      inviterEmail: emails.get(r.inviterUserId),
      inviteeEmail: emails.get(r.inviteeUserId),
      eventType: r.eventType as 'topup' | 'spend',
      baseCents: r.baseCents,
      rateBps: r.rateBps,
      commissionCents: r.commissionCents,
      createdAt: r.createdAt
    }))
  }

  totalCommission(tenant: string, inviterUserId?: number): number {
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${commissionLedger.commissionCents}), 0)` })
      .from(commissionLedger)
      .where(inviterUserId === undefined ? eq(commissionLedger.tenant, tenant) : and(eq(commissionLedger.tenant, tenant), eq(commissionLedger.inviterUserId, inviterUserId)))
      .get()
    return Number(row?.total) || 0
  }

  dashboard(tenant: string, inviterUserId: number): {
    rateBps: number
    totalCommissionCents: number
    invitedCount: number
    codes: InviteCodeView[]
    referrals: ReferralView[]
    commissions: CommissionView[]
  } {
    this.ensurePersonalCode(tenant, inviterUserId)
    const referralsList = this.listReferrals(tenant, inviterUserId)
    const commissions = this.listCommissions(tenant, inviterUserId, 200).map((row) => ({
      ...row,
      inviterEmail: undefined,
      inviteeEmail: row.inviteeEmail ? maskedEmail(row.inviteeEmail) : undefined
    }))
    return {
      rateBps: this.getRateBps(tenant),
      totalCommissionCents: this.totalCommission(tenant, inviterUserId),
      invitedCount: referralsList.length,
      codes: this.listCodes(tenant, inviterUserId),
      referrals: referralsList,
      commissions
    }
  }

  adminOverview(tenant: string): { rateBps: number; totalCommissionCents: number; codes: Array<InviteCodeView & { inviterUserId: number; inviterEmail?: string }>; referrals: ReferralView[]; commissions: CommissionView[] } {
    const emails = new Map(this.db.select({ id: clientUsers.id, email: clientUsers.email }).from(clientUsers).where(eq(clientUsers.tenant, tenant)).all().map((u) => [u.id, u.email]))
    const codes = this.db.select().from(inviteCodes).where(eq(inviteCodes.tenant, tenant)).orderBy(desc(inviteCodes.createdAt)).all().map((r) => ({ ...toInvite(r), inviterUserId: r.inviterUserId, inviterEmail: emails.get(r.inviterUserId) }))
    const relationRows = this.db.select().from(referrals).where(eq(referrals.tenant, tenant)).orderBy(desc(referrals.createdAt)).all()
    const commissions = this.listCommissions(tenant, undefined, 1000)
    // 明细只返回最近 1000 条以控制响应大小，但每位受邀人的累计佣金必须基于完整账本。
    const totals = new Map(
      this.db
        .select({
          inviteeUserId: commissionLedger.inviteeUserId,
          total: sql<number>`coalesce(sum(${commissionLedger.commissionCents}), 0)`
        })
        .from(commissionLedger)
        .where(eq(commissionLedger.tenant, tenant))
        .groupBy(commissionLedger.inviteeUserId)
        .all()
        .map((row) => [row.inviteeUserId, Number(row.total) || 0] as const)
    )
    return {
      rateBps: this.getRateBps(tenant),
      totalCommissionCents: this.totalCommission(tenant),
      codes,
      referrals: relationRows.map((r) => ({ userId: r.inviteeUserId, email: emails.get(r.inviteeUserId) ?? `#${r.inviteeUserId}`, inviterUserId: r.inviterUserId, inviterEmail: emails.get(r.inviterUserId), inviteCode: r.inviteCode, registeredAt: r.createdAt, commissionCents: totals.get(r.inviteeUserId) ?? 0 })),
      commissions
    }
  }
}

function toInvite(row: typeof inviteCodes.$inferSelect): InviteCodeView {
  return {
    code: row.code,
    enabled: row.enabled === 1,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt
  }
}
