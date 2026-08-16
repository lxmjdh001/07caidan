import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  computeFee,
  convertFromUsd,
  formatUsd,
  parseUsd,
  type FeeConfig
} from '../src/billing/money.ts'

describe('parseUsd', () => {
  test('常见输入都能解析成美分', () => {
    assert.equal(parseUsd('12.34'), 1234)
    assert.equal(parseUsd('12'), 1200)
    assert.equal(parseUsd('12.3'), 1230)
    assert.equal(parseUsd('$12.34'), 1234)
    assert.equal(parseUsd(' 1,200.00 '), 120000)
  })
  test('0 是合法金额（免费套餐）', () => {
    assert.equal(parseUsd('0'), 0)
  })
  test('非法输入返回 undefined 而不是 NaN', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1.2.3']) {
      assert.equal(parseUsd(bad), undefined, bad)
    }
  })
  test('浮点误差经典用例：0.1 + 0.2 的场景不会串味', () => {
    assert.equal(parseUsd('0.10')! + parseUsd('0.20')!, 30)
  })
})

describe('formatUsd', () => {
  test('始终两位小数', () => {
    assert.equal(formatUsd(1234), '12.34')
    assert.equal(formatUsd(1200), '12.00')
    assert.equal(formatUsd(5), '0.05')
    assert.equal(formatUsd(0), '0.00')
  })
  test('负数（退款）带符号', () => {
    assert.equal(formatUsd(-1234), '-12.34')
  })
})

describe('convertFromUsd', () => {
  test('换算成目标币种最小单位，默认向上取整', () => {
    // $1.00 × 7.2 = ¥7.20 → 720 分
    assert.equal(convertFromUsd(100, { currency: 'CNY', rate: 7.2 }), 720)
  })
  test('日元没有小数位', () => {
    assert.equal(convertFromUsd(100, { currency: 'JPY', rate: 148, decimals: 0 }), 148)
  })
  test('收款金额向上取整，宁可多收一分也不少收', () => {
    // $0.01 × 7.25 = ¥0.0725 → 向上取整到 8 分
    assert.equal(convertFromUsd(1, { currency: 'CNY', rate: 7.25 }), 8)
  })
})

function fee(o: Partial<FeeConfig> = {}): FeeConfig {
  return { rate: 0, fixed: 0, paidBy: 'merchant', ...o }
}

describe('computeFee — 商户承担', () => {
  test('用户付原价，手续费从实收里扣', () => {
    const r = computeFee(10000, fee({ rate: 0.024, fixed: 30, paidBy: 'merchant' }))
    assert.equal(r.payable, 10000)
    assert.equal(r.fee, 270) // 10000×2.4% + 30
    assert.equal(r.netToMerchant, 9730)
  })
  test('无费率时实收等于原价', () => {
    const r = computeFee(10000, fee())
    assert.deepEqual([r.payable, r.fee, r.netToMerchant], [10000, 0, 10000])
  })
})

describe('computeFee — 客户承担', () => {
  test('反算后商户实收不少于原始金额', () => {
    const r = computeFee(10000, fee({ rate: 0.024, fixed: 30, paidBy: 'customer' }))
    assert.ok(r.payable > 10000)
    // 关键断言：商户实收必须 >= 想要的金额，否则就是系统在贴钱
    assert.ok(r.netToMerchant >= 10000, `实收 ${r.netToMerchant} < 10000`)
  })

  test('简单加法会少收，反算不会 —— 这正是用 gross-up 的原因', () => {
    const amount = 10000
    const rate = 0.024
    const naive = amount + Math.round(amount * rate) // 天真做法：10240
    const r = computeFee(amount, fee({ rate, paidBy: 'customer' }))
    // 天真做法下通道按实付 10240 收 2.4% = 246，实收 9994 < 10000
    assert.ok(naive - Math.round(naive * rate) < amount)
    assert.ok(r.netToMerchant >= amount)
  })

  test('各种金额与费率下实收都不亏', () => {
    for (const amount of [1, 99, 100, 12345, 1000000]) {
      for (const rate of [0, 0.006, 0.024, 0.035, 0.1]) {
        for (const fixed of [0, 30, 200]) {
          const r = computeFee(amount, { rate, fixed, paidBy: 'customer' })
          const actualFee = Math.round(r.payable * rate) + fixed
          assert.ok(
            r.payable - actualFee >= amount,
            `amount=${amount} rate=${rate} fixed=${fixed} 实收不足`
          )
        }
      }
    }
  })

  test('payable = amount + fee 恒成立', () => {
    const r = computeFee(5000, fee({ rate: 0.03, fixed: 50, paidBy: 'customer' }))
    assert.equal(r.payable, r.amount + r.fee)
  })
})

describe('computeFee — 边界', () => {
  test('金额为 0 或负数时不产生费用', () => {
    assert.deepEqual(computeFee(0, fee({ rate: 0.1, paidBy: 'customer' })), {
      amount: 0,
      fee: 0,
      payable: 0,
      netToMerchant: 0
    })
    assert.equal(computeFee(-100, fee({ rate: 0.1 })).payable, 0)
  })
  test('费率被钳制在合理区间，不会除零或算出负数', () => {
    const r = computeFee(10000, fee({ rate: 5, paidBy: 'customer' }))
    assert.ok(Number.isFinite(r.payable) && r.payable > 0)
  })
  test('非法费率当作 0 处理', () => {
    assert.equal(computeFee(10000, fee({ rate: Number.NaN })).fee, 0)
    assert.equal(computeFee(10000, fee({ rate: -1 })).fee, 0)
  })
})
