import { describe, expect, it } from 'vitest'
import { estimatePayable, usd, type FeeInfo } from './billing-format'

describe('usd 金额格式化', () => {
  it('分补零到两位、带 $、负号', () => {
    expect(usd(1000)).toBe('$10.00')
    expect(usd(1005)).toBe('$10.05') // padStart 关键：不能是 $10.5
    expect(usd(1)).toBe('$0.01')
    expect(usd(0)).toBe('$0.00')
    expect(usd(-250)).toBe('-$2.50')
  })
})

describe('estimatePayable（客户端 gross-up 预估，须与服务端 computeFee 同口径）', () => {
  const fee = (o: Partial<FeeInfo> = {}): FeeInfo => ({ feeRate: 0, feeFixedCents: 0, feePaidBy: 'customer', ...o })

  it('商户承担手续费 → 应付=面值', () => {
    expect(estimatePayable(fee({ feePaidBy: 'merchant', feeRate: 0.03 }), 1000)).toBe(1000)
  })

  it('客户承担 3%+$0.30 → $10.62（与 e2e/服务端一致）', () => {
    // ceil((1000+30)/(1-0.03)) = ceil(1061.85) = 1062
    expect(estimatePayable(fee({ feeRate: 0.03, feeFixedCents: 30 }), 1000)).toBe(1062)
  })

  it('向上取整（宁可多收一分，不让商户实收不足）', () => {
    // ceil(1000/(1-0.024)) = ceil(1024.59) = 1025
    expect(estimatePayable(fee({ feeRate: 0.024 }), 1000)).toBe(1025)
  })

  it('费率被误配成 ≥1 时钳到 0.95，不算出 Infinity（与服务端 clampRate 一致，防预览崩成 $Infinity）', () => {
    const r = estimatePayable(fee({ feeRate: 1.0 }), 1000)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBe(Math.ceil(1000 / (1 - 0.95))) // 20000
  })

  it('金额 <=0 / 非法 → 原样返回（不预估）', () => {
    expect(estimatePayable(fee({ feeRate: 0.03 }), 0)).toBe(0)
    expect(estimatePayable(fee({ feeRate: 0.03 }), Number.NaN)).toBeNaN()
  })
})
