/**
 * 金额与手续费计算。
 *
 * 三条不可动摇的约定：
 *
 * 1. **一律用整数「美分」存储和计算**。浮点数在钱上迟早出事
 *    （0.1 + 0.2 !== 0.3），任何一次 toFixed 都可能吞掉或凭空造出一分钱。
 * 2. **美元是基准货币**。套餐价、余额、流水都以 USD 分记账；
 *    其它货币只在展示和收款时按汇率换算，且下单时必须把当次汇率**锁定存下来**，
 *    否则汇率一变，对账就再也对不上了。
 * 3. **所有取整都显式指定方向**。默认四舍五入，涉及退款给用户时向下取整，
 *    涉及向用户收费时向上取整 —— 让误差永远倒向用户有利的一侧，避免客诉。
 */

/** 金额，单位：美分（USD cents）。1 美元 = 100 */
export type Cents = number

export type Rounding = 'round' | 'floor' | 'ceil'

export function applyRounding(value: number, mode: Rounding): number {
  if (mode === 'floor') return Math.floor(value)
  if (mode === 'ceil') return Math.ceil(value)
  return Math.round(value)
}

/** 美元字符串 → 美分。用于管理员录入价格，容忍 "$12.34"、"12.3"、"12" */
export function parseUsd(input: string): Cents | undefined {
  const cleaned = input.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const [intPart, decPart = ''] = cleaned.split('.')
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : undefined
}

/** 美分 → 展示用美元字符串，始终两位小数 */
export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export interface ExchangeRate {
  /** 目标币种，如 CNY / JPY */
  currency: string
  /** 1 USD = rate 个目标币种单位 */
  rate: number
  /** 目标币种的小数位（日元为 0，多数为 2） */
  decimals?: number
}

/**
 * 美元金额换算成目标币种的**最小单位**整数。
 * 例：100 美分 + rate 7.2 + decimals 2 → 720（即 7.20 元）。
 * 收款金额一律向上取整：宁可多收一分也不能少收，否则通道对账会差。
 */
export function convertFromUsd(cents: Cents, rate: ExchangeRate, mode: Rounding = 'ceil'): number {
  const decimals = rate.decimals ?? 2
  const value = (cents / 100) * rate.rate * 10 ** decimals
  return applyRounding(value, mode)
}

export interface FeeConfig {
  /** 比例费率，0.024 表示 2.4% */
  rate: number
  /** 固定费（美分），如 PayPal 的每笔 $0.30 */
  fixed: Cents
  /**
   * 手续费由谁承担。
   * merchant：从收到的钱里扣，用户付多少就是多少。
   * customer：加在用户应付金额上，商户实收等于原始金额。
   */
  paidBy: 'merchant' | 'customer'
}

export interface FeeBreakdown {
  /** 商品本身的金额（用户想充值/购买的价值） */
  amount: Cents
  /** 手续费 */
  fee: Cents
  /** 用户实际需要支付的金额 */
  payable: Cents
  /** 商户最终实收（= payable - fee） */
  netToMerchant: Cents
}

/**
 * 计算手续费与应付金额。
 *
 * 「由客户承担」用的是**反算（gross-up）**而不是简单地在原金额上加 rate×amount：
 * 通道是按**实际支付金额**收费的，如果只加 rate×amount，
 * 商户实收会比预期少一点点（差 rate²×amount），量大了就是一笔账。
 *
 *   要让 payable - (rate×payable + fixed) = amount
 *   解得 payable = (amount + fixed) / (1 - rate)
 */
export function computeFee(amount: Cents, fee: FeeConfig): FeeBreakdown {
  if (amount <= 0) return { amount: 0, fee: 0, payable: 0, netToMerchant: 0 }
  const rate = clampRate(fee.rate)
  const fixed = Math.max(0, Math.round(fee.fixed))

  if (fee.paidBy === 'customer') {
    // 向上取整：差额宁可落在手续费里，也不能让商户实收不足
    const payable = Math.ceil((amount + fixed) / (1 - rate))
    const charged = payable - amount
    return { amount, fee: charged, payable, netToMerchant: payable - charged }
  }

  const charged = Math.round(amount * rate) + fixed
  return { amount, fee: charged, payable: amount, netToMerchant: amount - charged }
}

/** 费率必须落在 [0, 1)，1 及以上会让 gross-up 除零或变负 */
function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.min(rate, 0.95)
}
