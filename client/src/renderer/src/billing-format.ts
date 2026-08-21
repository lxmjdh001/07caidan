/**
 * 客户端计费展示：金额格式化 + 手续费应付预估。
 *
 * 预估口径**必须与服务端 `computeFee` 一致**（含 rate 钳制、fixed 归一），否则用户看到的
 * 「应付」预览会和真正下单时服务端算出的金额对不上——尤其费率被误配成 ≥1 时，不钳制会算出
 * Infinity/负数。之前这两个函数内联在 BillingPage 里、无单测，抽出来钉死与服务端同口径。
 */

export interface FeeInfo {
  feeRate: number
  feeFixedCents: number
  feePaidBy: 'merchant' | 'customer'
}

/** 费率钳到 [0, 0.95]，与服务端 clampRate 完全一致（≥1 会让 1-rate 变 0/负，算出 Infinity） */
function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.min(rate, 0.95)
}

/** 客户承担手续费时的应付金额（美分），gross-up 反算，向上取整。与服务端 computeFee 同口径。 */
export function estimatePayable(fee: FeeInfo, amountCents: number): number {
  if (fee.feePaidBy !== 'customer' || !Number.isFinite(amountCents) || amountCents <= 0) {
    return amountCents
  }
  const rate = clampRate(fee.feeRate)
  const fixed = Math.max(0, Math.round(fee.feeFixedCents))
  return Math.ceil((amountCents + fixed) / (1 - rate))
}

/** 美分 → "$X.YY"（负数带前导减号，分补零到两位） */
export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
