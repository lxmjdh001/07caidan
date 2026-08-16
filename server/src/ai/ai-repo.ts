import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { BillingRepo } from '../billing/billing-repo.ts'
import {
  creditsForUsage,
  isModelPurpose,
  type ModelPricing,
  type ModelPurpose,
  type TokenUsage
} from '../billing/credits.ts'
import type { Db } from '../db.ts'
import { aiModels, aiProviders, billingSettings, modelUsage } from '../schema.ts'
import { isProviderType, maskApiKey, type ProviderConfig, type ProviderType } from './protocols.ts'

export interface AiProvider {
  id: string
  type: ProviderType
  name: string
  baseUrl: string
  /** 打码后的 key，仅供展示 */
  apiKeyMasked: string
  enabled: boolean
  sortOrder: number
  createdAt: number
}

export interface AiProviderInput {
  type: string
  name: string
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
  sortOrder?: number
}

export interface AiModel {
  id: string
  providerId: string
  modelName: string
  label: string
  purposes: ModelPurpose[]
  creditsPerMillionInput: number
  creditsPerMillionOutput: number
  creditsPerAudioSecond: number
  minCredits: number
  enabled: boolean
  createdAt: number
}

export interface AiModelInput {
  providerId: string
  modelName: string
  label?: string
  purposes: string[]
  creditsPerMillionInput?: number
  creditsPerMillionOutput?: number
  creditsPerAudioSecond?: number
  minCredits?: number
  enabled?: boolean
}

export interface BillingSettings {
  creditsPerUsd: number
  autoTopUpCredits: boolean
}

export interface UsageRecord {
  id: number
  modelId: string
  purpose: ModelPurpose
  inputTokens: number
  outputTokens: number
  audioSeconds: number
  credits: number
  createdAt: number
}

export type ChargeResult =
  | { ok: true; credits: number; usageId: number }
  | { ok: false; reason: 'model_not_found' | 'model_disabled' | 'insufficient_credits' | 'insufficient_balance'; credits: number }

/**
 * AI 供应商 / 模型 / 用量。
 *
 * 计费口径：**先算积分再扣，扣失败就不记用量**。
 * 反过来（先记用量再扣费）会在余额不足时留下一条无人买单的用量记录，
 * 对账时永远差那么一笔。
 */
export class AiRepo {
  private readonly db: Db
  private readonly billing: BillingRepo

  constructor(db: Db, billing: BillingRepo) {
    this.db = db
    this.billing = billing
  }

  // ── 供应商 ──

  createProvider(tenant: string, input: AiProviderInput): AiProvider | null {
    if (!isProviderType(input.type)) return null
    const row = {
      tenant,
      id: randomUUID(),
      type: input.type,
      name: input.name,
      baseUrl: (input.baseUrl ?? '').trim(),
      apiKey: (input.apiKey ?? '').trim(),
      enabled: input.enabled === false ? 0 : 1,
      sortOrder: input.sortOrder ?? 0,
      createdAt: Date.now()
    }
    this.db.insert(aiProviders).values(row).run()
    return toProvider(row as typeof aiProviders.$inferSelect)
  }

  listProviders(tenant: string): AiProvider[] {
    return this.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.tenant, tenant))
      .orderBy(aiProviders.sortOrder, aiProviders.createdAt)
      .all()
      .map(toProvider)
  }

  updateProvider(tenant: string, id: string, patch: Partial<AiProviderInput>): boolean {
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.type !== undefined) {
      if (!isProviderType(patch.type)) return false
      set.type = patch.type
    }
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl.trim()
    // 空字符串表示「不修改密钥」，否则编辑其它字段就会把密钥清掉
    if (patch.apiKey) set.apiKey = patch.apiKey.trim()
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (Object.keys(set).length === 0) return true
    const res = this.db
      .update(aiProviders)
      .set(set)
      .where(and(eq(aiProviders.tenant, tenant), eq(aiProviders.id, id)))
      .run()
    return res.changes > 0
  }

  deleteProvider(tenant: string, id: string): boolean {
    return this.db.transaction((tx) => {
      tx.delete(aiModels)
        .where(and(eq(aiModels.tenant, tenant), eq(aiModels.providerId, id)))
        .run()
      const res = tx
        .delete(aiProviders)
        .where(and(eq(aiProviders.tenant, tenant), eq(aiProviders.id, id)))
        .run()
      return res.changes > 0
    })
  }

  /** 取可用于实际调用的完整配置（含明文密钥）。只能在服务端内部使用。 */
  providerConfig(tenant: string, id: string): ProviderConfig | null {
    const r = this.db
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.tenant, tenant), eq(aiProviders.id, id)))
      .get()
    if (!r || r.enabled !== 1) return null
    return { type: r.type as ProviderType, baseUrl: r.baseUrl || undefined, apiKey: r.apiKey }
  }

  // ── 模型 ──

  createModel(tenant: string, input: AiModelInput): AiModel {
    const row = {
      tenant,
      id: randomUUID(),
      providerId: input.providerId,
      modelName: input.modelName,
      label: input.label ?? input.modelName,
      purposes: JSON.stringify(input.purposes.filter(isModelPurpose)),
      creditsPerMillionInput: nonNeg(input.creditsPerMillionInput),
      creditsPerMillionOutput: nonNeg(input.creditsPerMillionOutput),
      creditsPerAudioSecond: nonNeg(input.creditsPerAudioSecond),
      minCredits: nonNeg(input.minCredits),
      enabled: input.enabled === false ? 0 : 1,
      createdAt: Date.now()
    }
    this.db.insert(aiModels).values(row).run()
    return toModel(row as typeof aiModels.$inferSelect)
  }

  listModels(tenant: string, opts: { providerId?: string; purpose?: ModelPurpose } = {}): AiModel[] {
    const rows = this.db
      .select()
      .from(aiModels)
      .where(
        opts.providerId
          ? and(eq(aiModels.tenant, tenant), eq(aiModels.providerId, opts.providerId))
          : eq(aiModels.tenant, tenant)
      )
      .orderBy(aiModels.createdAt)
      .all()
      .map(toModel)
    return opts.purpose ? rows.filter((m) => m.purposes.includes(opts.purpose!)) : rows
  }

  getModel(tenant: string, id: string): AiModel | null {
    const r = this.db
      .select()
      .from(aiModels)
      .where(and(eq(aiModels.tenant, tenant), eq(aiModels.id, id)))
      .get()
    return r ? toModel(r) : null
  }

  updateModel(tenant: string, id: string, patch: Partial<AiModelInput>): boolean {
    const set: Record<string, unknown> = {}
    if (patch.modelName !== undefined) set.modelName = patch.modelName
    if (patch.label !== undefined) set.label = patch.label
    if (patch.purposes !== undefined) {
      set.purposes = JSON.stringify(patch.purposes.filter(isModelPurpose))
    }
    if (patch.creditsPerMillionInput !== undefined) {
      set.creditsPerMillionInput = nonNeg(patch.creditsPerMillionInput)
    }
    if (patch.creditsPerMillionOutput !== undefined) {
      set.creditsPerMillionOutput = nonNeg(patch.creditsPerMillionOutput)
    }
    if (patch.creditsPerAudioSecond !== undefined) {
      set.creditsPerAudioSecond = nonNeg(patch.creditsPerAudioSecond)
    }
    if (patch.minCredits !== undefined) set.minCredits = nonNeg(patch.minCredits)
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (Object.keys(set).length === 0) return true
    const res = this.db
      .update(aiModels)
      .set(set)
      .where(and(eq(aiModels.tenant, tenant), eq(aiModels.id, id)))
      .run()
    return res.changes > 0
  }

  deleteModel(tenant: string, id: string): boolean {
    const res = this.db
      .delete(aiModels)
      .where(and(eq(aiModels.tenant, tenant), eq(aiModels.id, id)))
      .run()
    return res.changes > 0
  }

  // ── 计费参数 ──

  getSettings(tenant: string): BillingSettings {
    const r = this.db
      .select()
      .from(billingSettings)
      .where(eq(billingSettings.tenant, tenant))
      .get()
    return {
      creditsPerUsd: r?.creditsPerUsd ?? 1000,
      autoTopUpCredits: (r?.autoTopUpCredits ?? 1) === 1
    }
  }

  updateSettings(tenant: string, patch: Partial<BillingSettings>): BillingSettings {
    const current = this.getSettings(tenant)
    const next: BillingSettings = {
      // 兑换比例至少为 1，否则积分换钱会除零
      creditsPerUsd: Math.max(1, Math.floor(patch.creditsPerUsd ?? current.creditsPerUsd)),
      autoTopUpCredits: patch.autoTopUpCredits ?? current.autoTopUpCredits
    }
    this.db
      .insert(billingSettings)
      .values({
        tenant,
        creditsPerUsd: next.creditsPerUsd,
        autoTopUpCredits: next.autoTopUpCredits ? 1 : 0,
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: billingSettings.tenant,
        set: {
          creditsPerUsd: sql`excluded.credits_per_usd`,
          autoTopUpCredits: sql`excluded.auto_top_up_credits`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .run()
    return next
  }

  // ── 用量计费 ──

  /** 只算钱不落库，供调用前预估与前端展示 */
  estimate(tenant: string, modelId: string, usage: TokenUsage): number {
    const model = this.getModel(tenant, modelId)
    return model ? creditsForUsage(usage, pricingOf(model)) : 0
  }

  /**
   * 记录一次调用并扣费。
   * 扣费失败则**不写用量记录** —— 否则会留下一条没人买单的用量，对账永远差一笔。
   */
  chargeUsage(
    tenant: string,
    userId: number,
    modelId: string,
    purpose: ModelPurpose,
    usage: TokenUsage,
    now = Date.now()
  ): ChargeResult {
    const model = this.getModel(tenant, modelId)
    if (!model) return { ok: false, reason: 'model_not_found', credits: 0 }
    if (!model.enabled) return { ok: false, reason: 'model_disabled', credits: 0 }

    const credits = creditsForUsage(usage, pricingOf(model))
    const settings = this.getSettings(tenant)

    const charge = this.billing.chargeCredits(tenant, userId, credits, {
      autoTopUp: settings.autoTopUpCredits,
      rate: { creditsPerUsd: settings.creditsPerUsd },
      refId: modelId,
      note: `${model.label || model.modelName} · ${purpose}`,
      now
    })
    if (!charge.ok) {
      return {
        ok: false,
        reason: (charge.reason as 'insufficient_credits' | 'insufficient_balance') ??
          'insufficient_credits',
        credits
      }
    }

    const res = this.db
      .insert(modelUsage)
      .values({
        tenant,
        userId,
        modelId,
        purpose,
        inputTokens: nonNeg(usage.inputTokens),
        outputTokens: nonNeg(usage.outputTokens),
        audioSeconds: nonNeg(usage.audioSeconds),
        credits,
        createdAt: now
      })
      .run()

    return { ok: true, credits, usageId: Number(res.lastInsertRowid) }
  }

  listUsage(tenant: string, userId: number, limit = 100): UsageRecord[] {
    return this.db
      .select()
      .from(modelUsage)
      .where(and(eq(modelUsage.tenant, tenant), eq(modelUsage.userId, userId)))
      .orderBy(desc(modelUsage.createdAt), desc(modelUsage.id))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        modelId: r.modelId,
        purpose: r.purpose as ModelPurpose,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        audioSeconds: r.audioSeconds,
        credits: r.credits,
        createdAt: r.createdAt
      }))
  }

  /** 用量汇总（按模型与用途分组），管理后台看成本分布用 */
  usageSummary(
    tenant: string,
    opts: { userId?: number; from?: number; to?: number } = {}
  ): Array<{ modelId: string; purpose: string; calls: number; credits: number }> {
    const conds = [eq(modelUsage.tenant, tenant)]
    if (opts.userId !== undefined) conds.push(eq(modelUsage.userId, opts.userId))
    if (opts.from !== undefined) conds.push(sql`${modelUsage.createdAt} >= ${opts.from}`)
    if (opts.to !== undefined) conds.push(sql`${modelUsage.createdAt} <= ${opts.to}`)
    return this.db
      .select({
        modelId: modelUsage.modelId,
        purpose: modelUsage.purpose,
        calls: sql<number>`COUNT(*)`,
        credits: sql<number>`SUM(${modelUsage.credits})`
      })
      .from(modelUsage)
      .where(and(...conds))
      .groupBy(modelUsage.modelId, modelUsage.purpose)
      .all()
      .map((r) => ({
        modelId: r.modelId,
        purpose: r.purpose,
        calls: Number(r.calls),
        credits: Number(r.credits ?? 0)
      }))
  }
}

function nonNeg(v: number | undefined): number {
  const n = Math.floor(Number(v ?? 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function pricingOf(m: AiModel): ModelPricing {
  return {
    creditsPerMillionInput: m.creditsPerMillionInput,
    creditsPerMillionOutput: m.creditsPerMillionOutput,
    creditsPerAudioSecond: m.creditsPerAudioSecond,
    minCredits: m.minCredits
  }
}

function toProvider(r: typeof aiProviders.$inferSelect): AiProvider {
  return {
    id: r.id,
    type: r.type as ProviderType,
    name: r.name,
    baseUrl: r.baseUrl,
    apiKeyMasked: maskApiKey(r.apiKey),
    enabled: r.enabled === 1,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt
  }
}

function toModel(r: typeof aiModels.$inferSelect): AiModel {
  let purposes: ModelPurpose[] = []
  try {
    const parsed = JSON.parse(r.purposes)
    if (Array.isArray(parsed)) purposes = parsed.filter(isModelPurpose)
  } catch {
    purposes = []
  }
  return {
    id: r.id,
    providerId: r.providerId,
    modelName: r.modelName,
    label: r.label,
    purposes,
    creditsPerMillionInput: r.creditsPerMillionInput,
    creditsPerMillionOutput: r.creditsPerMillionOutput,
    creditsPerAudioSecond: r.creditsPerAudioSecond,
    minCredits: r.minCredits,
    enabled: r.enabled === 1,
    createdAt: r.createdAt
  }
}
