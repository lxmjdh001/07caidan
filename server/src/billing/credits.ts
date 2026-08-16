import { applyRounding, type Cents } from './money.ts'

/**
 * 模型积分。
 *
 * 为什么不直接用钱计费：不同供应商、不同模型的单价差好几个数量级，
 * 而且会随供应商调价变动。中间加一层「积分」，管理员改单价时
 * 只动积分单价表，用户侧的余额与充值口径不受影响。
 *
 * 积分同样用**整数**存储，避免浮点误差在高频调用下累积。
 */

/** 模型用途，用于用量归类与限额 */
export type ModelPurpose = 'asr' | 'translate' | 'autoreply'

export const MODEL_PURPOSES: ModelPurpose[] = ['asr', 'translate', 'autoreply']

export function isModelPurpose(v: string): v is ModelPurpose {
  return (MODEL_PURPOSES as string[]).includes(v)
}

export interface ModelPricing {
  /**
   * 每 100 万输入 token 的积分数。
   * 用「每百万」而不是「每 token」是因为单 token 的价格远小于 1，
   * 存成整数才不会被四舍五入抹平各模型之间的差异。
   */
  creditsPerMillionInput: number
  creditsPerMillionOutput: number
  /**
   * 语音识别按秒计费的积分数（ASR 模型不按 token 算）。
   * 与 token 单价互斥使用，取决于 usage 传的是哪种。
   */
  creditsPerAudioSecond?: number
  /** 每次调用的最低扣费，避免大量极短请求把成本摊没 */
  minCredits?: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /** 语音时长（秒），ASR 用 */
  audioSeconds?: number
}

/**
 * 用量 → 积分。
 *
 * 一律**向上取整**：模型成本是实打实花掉的，向下取整等于系统自己贴钱，
 * 高频小请求下这个漏洞会被放大。
 */
export function creditsForUsage(usage: TokenUsage, pricing: ModelPricing): number {
  const input = Math.max(0, usage.inputTokens ?? 0)
  const output = Math.max(0, usage.outputTokens ?? 0)
  const audio = Math.max(0, usage.audioSeconds ?? 0)

  let credits = 0
  credits += (input / 1_000_000) * Math.max(0, pricing.creditsPerMillionInput)
  credits += (output / 1_000_000) * Math.max(0, pricing.creditsPerMillionOutput)
  credits += audio * Math.max(0, pricing.creditsPerAudioSecond ?? 0)

  const rounded = applyRounding(credits, 'ceil')
  const min = Math.max(0, Math.floor(pricing.minCredits ?? 0))
  // 完全没有用量时不收最低消费，否则调用失败也要扣钱
  if (input === 0 && output === 0 && audio === 0) return 0
  return Math.max(rounded, min)
}

export interface CreditRate {
  /** 1 美元（100 美分）可兑换多少积分 */
  creditsPerUsd: number
}

/** 积分 → 需要从余额扣除的美分（向上取整，不让系统贴钱） */
export function creditsToCents(credits: number, rate: CreditRate): Cents {
  const per = Math.max(1, rate.creditsPerUsd)
  return applyRounding((Math.max(0, credits) / per) * 100, 'ceil')
}

/** 美分 → 可兑换的积分（向下取整，不多送） */
export function centsToCredits(cents: Cents, rate: CreditRate): number {
  const per = Math.max(1, rate.creditsPerUsd)
  return applyRounding((Math.max(0, cents) / 100) * per, 'floor')
}

export interface DeductInput {
  /** 当前积分余额 */
  credits: number
  /** 当前钱余额（美分） */
  balanceCents: Cents
  /** 本次要扣的积分 */
  cost: number
  /** 积分不足时是否自动从余额兑换补足 */
  autoTopUp: boolean
  rate: CreditRate
}

export interface DeductResult {
  ok: boolean
  /** 从积分余额扣掉的部分 */
  creditsUsed: number
  /** 为补足而从钱余额扣掉的金额 */
  centsUsed: Cents
  /** 扣费后的积分余额 */
  credits: number
  /** 扣费后的钱余额 */
  balanceCents: Cents
  /** 失败原因，成功时为空 */
  reason?: 'insufficient_credits' | 'insufficient_balance'
}

/**
 * 扣减积分，必要时自动从余额兑换补足。
 *
 * 关键点：**要么全额扣成功，要么什么都不扣**。
 * 半扣状态会让用户既掉了钱又没拿到结果，对账也说不清。
 */
export function deductCredits(input: DeductInput): DeductResult {
  const { credits, balanceCents, cost, autoTopUp, rate } = input
  const unchanged = {
    creditsUsed: 0,
    centsUsed: 0,
    credits,
    balanceCents
  }

  if (cost <= 0) return { ok: true, ...unchanged }

  if (credits >= cost) {
    return { ok: true, creditsUsed: cost, centsUsed: 0, credits: credits - cost, balanceCents }
  }

  if (!autoTopUp) return { ok: false, ...unchanged, reason: 'insufficient_credits' }

  const shortfall = cost - credits
  const needCents = creditsToCents(shortfall, rate)
  if (balanceCents < needCents) {
    return { ok: false, ...unchanged, reason: 'insufficient_balance' }
  }

  return {
    ok: true,
    creditsUsed: credits,
    centsUsed: needCents,
    credits: 0,
    balanceCents: balanceCents - needCents
  }
}
