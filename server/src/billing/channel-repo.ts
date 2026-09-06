import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { exchangeRates, paymentChannels } from '../schema.ts'
import type { FeeConfig } from './money.ts'

export type ChannelType = 'yipay' | 'paypal' | 'usdt' | 'mock'

export const CHANNEL_TYPES: ChannelType[] = ['yipay', 'paypal', 'usdt', 'mock']

export function isChannelType(v: string): v is ChannelType {
  return (CHANNEL_TYPES as string[]).includes(v)
}

export interface PaymentChannel {
  id: string
  type: ChannelType
  name: string
  enabled: boolean
  /** 配置键值；给前端时敏感键要打码 */
  config: Record<string, string>
  feeRate: number
  feeFixedCents: number
  feePaidBy: 'merchant' | 'customer'
  currency: string
  sortOrder: number
  createdAt: number
}

export interface ChannelInput {
  type: string
  name: string
  enabled?: boolean
  config?: Record<string, string>
  feeRate?: number
  feeFixedCents?: number
  feePaidBy?: 'merchant' | 'customer'
  currency?: string
  sortOrder?: number
}

/** 通道配置里不能回传给前端的键 */
const SECRET_KEYS = new Set([
  'key',
  'apiKey',
  'clientSecret',
  'callbackSecret',
  'queryApiSecret',
  'webhookId'
])

export function maskChannelConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_KEYS.has(k) && v ? '••••••' : v
  }
  return out
}

export interface Rate {
  currency: string
  rate: number
  decimals: number
}

/** 支付通道与汇率配置 */
export class ChannelRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  create(tenant: string, input: ChannelInput): PaymentChannel | null {
    if (!isChannelType(input.type)) return null
    const row = {
      tenant,
      id: randomUUID(),
      type: input.type,
      name: input.name,
      enabled: input.enabled === false ? 0 : 1,
      config: JSON.stringify(input.config ?? {}),
      // 费率存字符串：0.024 这类数在浮点列里存取可能失真，而费率是对账依据
      feeRate: String(clampRate(input.feeRate ?? 0)),
      feeFixedCents: Math.max(0, Math.round(input.feeFixedCents ?? 0)),
      feePaidBy: input.feePaidBy === 'customer' ? 'customer' : 'merchant',
      currency: (input.currency ?? 'USD').toUpperCase(),
      sortOrder: input.sortOrder ?? 0,
      createdAt: Date.now()
    }
    this.db.insert(paymentChannels).values(row).run()
    return toChannel(row as typeof paymentChannels.$inferSelect)
  }

  list(tenant: string, onlyEnabled = false): PaymentChannel[] {
    return this.db
      .select()
      .from(paymentChannels)
      .where(
        onlyEnabled
          ? and(eq(paymentChannels.tenant, tenant), eq(paymentChannels.enabled, 1))
          : eq(paymentChannels.tenant, tenant)
      )
      .orderBy(paymentChannels.sortOrder, paymentChannels.createdAt)
      .all()
      .map(toChannel)
  }

  get(tenant: string, id: string): PaymentChannel | null {
    const r = this.db
      .select()
      .from(paymentChannels)
      .where(and(eq(paymentChannels.tenant, tenant), eq(paymentChannels.id, id)))
      .get()
    return r ? toChannel(r) : null
  }

  update(tenant: string, id: string, patch: Partial<ChannelInput>): boolean {
    const current = this.get(tenant, id)
    if (!current) return false
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.config !== undefined) {
      // 合并而不是替换：前端表单里打码的敏感键不回传，直接替换会把密钥抹掉
      const merged = { ...current.config }
      for (const [k, v] of Object.entries(patch.config)) {
        if (v === '••••••') continue
        merged[k] = v
      }
      set.config = JSON.stringify(merged)
    }
    if (patch.feeRate !== undefined) set.feeRate = String(clampRate(patch.feeRate))
    if (patch.feeFixedCents !== undefined) {
      set.feeFixedCents = Math.max(0, Math.round(patch.feeFixedCents))
    }
    if (patch.feePaidBy !== undefined) {
      set.feePaidBy = patch.feePaidBy === 'customer' ? 'customer' : 'merchant'
    }
    if (patch.currency !== undefined) set.currency = patch.currency.toUpperCase()
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (Object.keys(set).length === 0) return true
    const res = this.db
      .update(paymentChannels)
      .set(set)
      .where(and(eq(paymentChannels.tenant, tenant), eq(paymentChannels.id, id)))
      .run()
    return res.changes > 0
  }

  delete(tenant: string, id: string): boolean {
    const res = this.db
      .delete(paymentChannels)
      .where(and(eq(paymentChannels.tenant, tenant), eq(paymentChannels.id, id)))
      .run()
    return res.changes > 0
  }

  feeOf(channel: PaymentChannel): FeeConfig {
    return { rate: channel.feeRate, fixed: channel.feeFixedCents, paidBy: channel.feePaidBy }
  }

  // ── 汇率 ──

  setRate(tenant: string, currency: string, rate: number, decimals = 2): void {
    this.db
      .insert(exchangeRates)
      .values({
        tenant,
        currency: currency.toUpperCase(),
        rate: String(rate),
        decimals,
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: [exchangeRates.tenant, exchangeRates.currency],
        set: {
          rate: sql`excluded.rate`,
          decimals: sql`excluded.decimals`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .run()
  }

  listRates(tenant: string): Rate[] {
    return this.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.tenant, tenant))
      .all()
      .map((r) => ({ currency: r.currency, rate: Number(r.rate), decimals: r.decimals }))
  }

  /** 取某币种汇率；USD 恒为 1，未配置的币种返回 null（下单必须显式失败） */
  getRate(tenant: string, currency: string): Rate | null {
    const cur = currency.toUpperCase()
    if (cur === 'USD') return { currency: 'USD', rate: 1, decimals: 2 }
    // USDT 与美元 1:1 锚定，未配置时默认按 1 处理
    if (cur === 'USDT') {
      const custom = this.findRate(tenant, cur)
      return custom ?? { currency: 'USDT', rate: 1, decimals: 2 }
    }
    return this.findRate(tenant, cur)
  }

  private findRate(tenant: string, currency: string): Rate | null {
    const r = this.db
      .select()
      .from(exchangeRates)
      .where(and(eq(exchangeRates.tenant, tenant), eq(exchangeRates.currency, currency)))
      .get()
    return r ? { currency: r.currency, rate: Number(r.rate), decimals: r.decimals } : null
  }

  deleteRate(tenant: string, currency: string): boolean {
    const res = this.db
      .delete(exchangeRates)
      .where(and(eq(exchangeRates.tenant, tenant), eq(exchangeRates.currency, currency.toUpperCase())))
      .run()
    return res.changes > 0
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) return 0
  return Math.min(rate, 0.95)
}

function toChannel(r: typeof paymentChannels.$inferSelect): PaymentChannel {
  let config: Record<string, string> = {}
  try {
    const parsed = JSON.parse(r.config)
    if (parsed && typeof parsed === 'object') {
      config = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
      )
    }
  } catch {
    config = {}
  }
  return {
    id: r.id,
    type: r.type as ChannelType,
    name: r.name,
    enabled: r.enabled === 1,
    config,
    feeRate: Number(r.feeRate),
    feeFixedCents: r.feeFixedCents,
    feePaidBy: r.feePaidBy === 'customer' ? 'customer' : 'merchant',
    currency: r.currency,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt
  }
}
