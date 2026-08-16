import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  accountQuotaState,
  computeProration,
  expiryOf,
  periodDays,
  remainingDays,
  renewExpiry,
  type PlanSnapshot
} from '../src/billing/plans.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 7, 17, 0, 0, 0)

describe('周期', () => {
  test('四种标准周期的天数', () => {
    assert.equal(periodDays({ unit: 'month' }), 30)
    assert.equal(periodDays({ unit: 'quarter' }), 90)
    assert.equal(periodDays({ unit: 'half_year' }), 180)
    assert.equal(periodDays({ unit: 'year' }), 365)
  })
  test('count 表示几个周期', () => {
    assert.equal(periodDays({ unit: 'month', count: 3 }), 90)
  })
  test('自定义天数走 unit=day', () => {
    assert.equal(periodDays({ unit: 'day', count: 45 }), 45)
  })
  test('非法 count 兜底为 1 个周期', () => {
    assert.equal(periodDays({ unit: 'month', count: 0 }), 30)
    assert.equal(periodDays({ unit: 'month', count: -5 }), 30)
  })
  test('到期时间 = 开始 + 周期天数', () => {
    assert.equal(expiryOf(T0, { unit: 'month' }), T0 + 30 * DAY)
  })
})

describe('remainingDays', () => {
  test('已过期为 0，不会出现负数', () => {
    assert.equal(remainingDays(T0, T0 - DAY), 0)
    assert.equal(remainingDays(T0, T0), 0)
  })
  test('不足一天按一天算（对用户宽松）', () => {
    assert.equal(remainingDays(T0, T0 + DAY / 2), 1)
  })
  test('整数天', () => {
    assert.equal(remainingDays(T0, T0 + 10 * DAY), 10)
  })
})

const monthly: PlanSnapshot = { priceCents: 3000, period: { unit: 'month' } }
const yearly: PlanSnapshot = { priceCents: 30000, period: { unit: 'year' } }

describe('升降级折算', () => {
  test('没有旧套餐时全额收新套餐', () => {
    const r = computeProration(T0, undefined, undefined, monthly)
    assert.equal(r.creditFromOld, 0)
    assert.equal(r.chargeForNew, 3000)
    assert.equal(r.net, 3000)
  })

  test('用满一半升级：退回旧套餐一半价值', () => {
    const expires = T0 + 15 * DAY
    const r = computeProration(T0, monthly, expires, yearly)
    assert.equal(r.remainingDays, 15)
    assert.equal(r.creditFromOld, 1500) // 3000 × 15/30
    assert.equal(r.net, 30000 - 1500)
  })

  test('降级时净额可能为负 —— 差额退回余额', () => {
    const expires = T0 + 300 * DAY
    const r = computeProration(T0, yearly, expires, monthly)
    // 30000 × 300/365 = 24657.5 → 向下取整 24657
    assert.equal(r.creditFromOld, 24657)
    assert.ok(r.net < 0, '降级应产生退款')
    assert.equal(r.net, 3000 - 24657)
  })

  test('旧套餐已过期则不退任何钱', () => {
    const r = computeProration(T0, monthly, T0 - DAY, yearly)
    assert.equal(r.creditFromOld, 0)
    assert.equal(r.net, 30000)
  })

  test('退款向下取整 —— 系统不会多退', () => {
    // 1000 × 7/30 = 233.33 → 233
    const r = computeProration(
      T0,
      { priceCents: 1000, period: { unit: 'month' } },
      T0 + 7 * DAY,
      monthly
    )
    assert.equal(r.creditFromOld, 233)
  })

  test('剩余天数超过周期总天数时按总天数封顶（防脏数据退超额）', () => {
    const r = computeProration(T0, monthly, T0 + 999 * DAY, monthly)
    assert.equal(r.creditFromOld, 3000, '最多只退一整个周期的钱')
  })

  test('新套餐到期时间从当下重新起算一个完整周期', () => {
    const r = computeProration(T0, monthly, T0 + 15 * DAY, yearly)
    assert.equal(r.newExpiresAt, T0 + 365 * DAY)
  })

  test('同价同周期切换净额为 0', () => {
    const r = computeProration(T0, monthly, T0 + 30 * DAY, monthly)
    assert.equal(r.net, 0)
  })
})

describe('自动续费', () => {
  test('未过期时在原到期时间上顺延，不吞用户时间', () => {
    const expires = T0 + 5 * DAY
    assert.equal(renewExpiry(expires, T0, { unit: 'month' }), expires + 30 * DAY)
  })
  test('已过期则从当下起算', () => {
    assert.equal(renewExpiry(T0 - 10 * DAY, T0, { unit: 'month' }), T0 + 30 * DAY)
  })
})

describe('账号数配额', () => {
  test('未超限可继续新增', () => {
    assert.deepEqual(accountQuotaState(3, 10), {
      withinQuota: true,
      canAddMore: true,
      overBy: 0
    })
  })
  test('刚好用满：不算超限但不能再加', () => {
    assert.deepEqual(accountQuotaState(10, 10), {
      withinQuota: true,
      canAddMore: false,
      overBy: 0
    })
  })
  test('降级后超限：只禁止新增，不强制踢下线', () => {
    const s = accountQuotaState(20, 10)
    assert.equal(s.withinQuota, false)
    assert.equal(s.canAddMore, false)
    assert.equal(s.overBy, 10)
  })
})
