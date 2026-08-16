import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { sweepBilling } from '../src/billing/billing-cron.ts'
import { BillingRepo } from '../src/billing/billing-repo.ts'
import { OrderRepo } from '../src/billing/order-repo.ts'
import { openDb } from '../src/db.ts'

const T = 'tenant-1'
const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0)

let dir: string
let billing: BillingRepo
let orders: OrderRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-cron-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  billing = new BillingRepo(db)
  orders = new OrderRepo(db, billing)
})

function deps() {
  return { billing, orders, tenants: () => [T] }
}

describe('计费巡检', () => {
  test('开了自动续费且余额够 → 续费并顺延', () => {
    const plan = billing.createPlan(T, { name: 'A', priceCents: 3000, periodUnit: 'month', maxAccounts: 5 })
    billing.mutate(T, { userId: 1, kind: 'topup', amountCents: 10000, now: NOW })
    billing.changePlan(T, 1, plan.id, NOW)
    billing.setAutoRenew(T, 1, true)

    const due = NOW + 31 * DAY
    const r = sweepBilling(deps(), due)
    assert.equal(r.renewed, 1)
    const sub = billing.getSubscription(T, 1)
    assert.equal(sub?.status, 'active')
    assert.ok(sub!.expiresAt > due)
  })

  test('余额不足 → 标记过期，不透支', () => {
    const plan = billing.createPlan(T, { name: 'A', priceCents: 3000, periodUnit: 'month', maxAccounts: 5 })
    billing.mutate(T, { userId: 1, kind: 'topup', amountCents: 3000, now: NOW })
    billing.changePlan(T, 1, plan.id, NOW)
    billing.setAutoRenew(T, 1, true)

    const r = sweepBilling(deps(), NOW + 31 * DAY)
    assert.equal(r.expired, 1)
    assert.equal(billing.getSubscription(T, 1)?.status, 'expired')
    assert.equal(billing.getBalance(T, 1).balanceCents, 0)
  })

  test('未开自动续费 → 直接过期', () => {
    const plan = billing.createPlan(T, { name: 'A', priceCents: 0, periodUnit: 'month', maxAccounts: 5 })
    billing.changePlan(T, 1, plan.id, NOW)
    const r = sweepBilling(deps(), NOW + 31 * DAY)
    assert.equal(r.expired, 1)
    assert.equal(billing.getSubscription(T, 1)?.status, 'expired')
  })

  test('未到期的订阅不受影响', () => {
    const plan = billing.createPlan(T, { name: 'A', priceCents: 0, periodUnit: 'month', maxAccounts: 5 })
    billing.changePlan(T, 1, plan.id, NOW)
    const r = sweepBilling(deps(), NOW + DAY)
    assert.equal(r.expired + r.renewed, 0)
    assert.equal(billing.getSubscription(T, 1)?.status, 'active')
  })

  test('超时未付订单被清理', () => {
    orders.create(T, {
      userId: 1, kind: 'topup', amountCents: 1000, channelId: 'c', channelType: 'mock',
      fee: { rate: 0, fixed: 0, paidBy: 'merchant' }, currency: 'USD', rate: 1, now: NOW
    })
    const r = sweepBilling(deps(), NOW + DAY)
    assert.equal(r.ordersExpired, 1)
  })

  test('巡检幂等：同一时刻跑两遍不会重复扣费', () => {
    const plan = billing.createPlan(T, { name: 'A', priceCents: 3000, periodUnit: 'month', maxAccounts: 5 })
    billing.mutate(T, { userId: 1, kind: 'topup', amountCents: 10000, now: NOW })
    billing.changePlan(T, 1, plan.id, NOW)
    billing.setAutoRenew(T, 1, true)

    const due = NOW + 31 * DAY
    sweepBilling(deps(), due)
    const balanceAfterFirst = billing.getBalance(T, 1).balanceCents
    const second = sweepBilling(deps(), due)
    assert.equal(second.renewed, 0, '已续费的订阅不再到期')
    assert.equal(billing.getBalance(T, 1).balanceCents, balanceAfterFirst)
  })
})
