import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { BillingRepo } from '../src/billing/billing-repo.ts'
import type { FeeConfig } from '../src/billing/money.ts'
import { OrderRepo, type CreateOrderInput } from '../src/billing/order-repo.ts'
import { openDb } from '../src/db.ts'

const T = 'tenant-1'
const U = 7
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0)

let dir: string
let billing: BillingRepo
let repo: OrderRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-orders-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  billing = new BillingRepo(db)
  repo = new OrderRepo(db, billing)
})

const noFee: FeeConfig = { rate: 0, fixed: 0, paidBy: 'merchant' }

function order(o: Partial<CreateOrderInput> = {}) {
  return repo.create(T, {
    userId: U,
    kind: 'topup',
    amountCents: 10000,
    channelId: 'ch1',
    channelType: 'yipay',
    fee: noFee,
    currency: 'USD',
    rate: 1,
    now: NOW,
    ...o
  })
}

describe('建单', () => {
  test('订单号唯一', () => {
    const ids = new Set(Array.from({ length: 30 }, () => OrderRepo.newOrderId(NOW)))
    assert.equal(ids.size, 30)
  })

  test('无手续费时应付等于商品价值', () => {
    const o = order()
    assert.equal(o.amountCents, 10000)
    assert.equal(o.feeCents, 0)
    assert.equal(o.payableCents, 10000)
    assert.equal(o.payableLocal, 10000)
    assert.equal(o.status, 'pending')
  })

  test('客户承担手续费时应付高于商品价值', () => {
    const o = order({ fee: { rate: 0.024, fixed: 30, paidBy: 'customer' } })
    assert.ok(o.payableCents > o.amountCents)
    assert.equal(o.payableCents, o.amountCents + o.feeCents)
  })

  test('商户承担时用户付原价', () => {
    const o = order({ fee: { rate: 0.024, fixed: 30, paidBy: 'merchant' } })
    assert.equal(o.payableCents, 10000)
    assert.ok(o.feeCents > 0)
  })

  test('非美元通道按汇率换算并锁定汇率', () => {
    const o = order({ currency: 'CNY', rate: 7.2 })
    assert.equal(o.currency, 'CNY')
    assert.equal(o.lockedRate, 7.2)
    assert.equal(o.payableLocal, 72000, '$100 × 7.2 = ¥720.00')
  })

  test('日元无小数位', () => {
    const o = order({ currency: 'JPY', rate: 148, decimals: 0 })
    assert.equal(o.payableLocal, 14800, '$100 × 148 = ¥14800')
  })

  test('汇率以字符串存储，读回不失真', () => {
    const o = order({ currency: 'CNY', rate: 7.1234 })
    assert.equal(repo.get(T, o.id)?.lockedRate, 7.1234)
  })
})

describe('结算与幂等', () => {
  test('首次结算入账并置为已支付', () => {
    const o = order()
    const r = repo.settle(T, o.id, { tradeNo: 'T1', paidAmountLocal: 10000, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.alreadyPaid, false)
    assert.equal(repo.get(T, o.id)?.status, 'paid')
    assert.equal(billing.getBalance(T, U).balanceCents, 10000)
  })

  test('重复回调只入账一次 —— 支付通道普遍会重推', () => {
    const o = order()
    for (let i = 0; i < 5; i++) {
      const r = repo.settle(T, o.id, { tradeNo: 'T1', paidAmountLocal: 10000, now: NOW })
      assert.equal(r.ok, true)
      if (i > 0) assert.equal(r.ok && r.alreadyPaid, true, `第 ${i + 1} 次应识别为重复`)
    }
    assert.equal(billing.getBalance(T, U).balanceCents, 10000, '余额只应增加一次')
    assert.equal(
      billing.listLedger(T, U).filter((l) => l.kind === 'topup').length,
      1,
      '流水只应有一条'
    )
  })

  test('同一外部流水不能给两笔订单重复入账', () => {
    const first = order({ amountCents: 1000 })
    const second = order({ amountCents: 1000 })
    assert.equal(repo.settle(T, first.id, { tradeNo: 'OKX-BILL-1', now: NOW }).ok, true)
    const duplicate = repo.settle(T, second.id, { tradeNo: 'OKX-BILL-1', now: NOW })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.ok === false && duplicate.reason, 'payment_reused')
    assert.equal(repo.get(T, second.id)?.status, 'pending')
    assert.equal(billing.getBalance(T, U).balanceCents, 1000)
  })

  test('入账金额是商品价值，客户承担的手续费不进余额', () => {
    const o = order({ fee: { rate: 0.05, fixed: 0, paidBy: 'customer' } })
    repo.settle(T, o.id, { paidAmountLocal: o.payableLocal, now: NOW })
    assert.equal(
      billing.getBalance(T, U).balanceCents,
      10000,
      '用户付了含手续费的钱，但到账仍是他买的价值'
    )
  })

  test('实付金额不足直接拒绝 —— 只验签不验金额是典型漏洞', () => {
    const o = order()
    const r = repo.settle(T, o.id, { paidAmountLocal: 1, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'amount_mismatch')
    assert.equal(repo.get(T, o.id)?.status, 'pending')
    assert.equal(billing.getBalance(T, U).balanceCents, 0)
  })

  test('多付则接受（用户自己多转的，不该卡住订单）', () => {
    const o = order()
    const r = repo.settle(T, o.id, { paidAmountLocal: 99999, now: NOW })
    assert.equal(r.ok, true)
  })

  test('不传金额时跳过校验（部分通道回调不带金额）', () => {
    const o = order()
    assert.equal(repo.settle(T, o.id, { now: NOW }).ok, true)
  })

  test('过期订单不能结算，且被标记为过期', () => {
    const o = order()
    const late = o.expiresAt + 1000
    const r = repo.settle(T, o.id, { paidAmountLocal: 10000, now: late })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'expired')
    assert.equal(repo.get(T, o.id)?.status, 'expired')
    assert.equal(billing.getBalance(T, U).balanceCents, 0)
  })

  test('不存在的订单号', () => {
    const r = repo.settle(T, 'nope', { now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'not_found')
  })

  test('已过期的订单再回调不会入账', () => {
    const o = order()
    repo.markExpired(T, o.id)
    const r = repo.settle(T, o.id, { now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'not_pending')
    assert.equal(billing.getBalance(T, U).balanceCents, 0)
  })

  test('两笔不同订单各自入账', () => {
    const a = order({ amountCents: 1000 })
    const b = order({ amountCents: 2000 })
    repo.settle(T, a.id, { now: NOW })
    repo.settle(T, b.id, { now: NOW })
    assert.equal(billing.getBalance(T, U).balanceCents, 3000)
  })

  test('结算后账仍然是平的', () => {
    const o = order()
    repo.settle(T, o.id, { now: NOW })
    assert.equal(billing.auditBalance(T, U).consistent, true)
  })
})

describe('订单维护', () => {
  test('批量过期只影响待支付订单', () => {
    const a = order()
    const b = order()
    repo.settle(T, b.id, { now: NOW })
    const n = repo.expireStale(T, a.expiresAt + 1)
    assert.equal(n, 1)
    assert.equal(repo.get(T, a.id)?.status, 'expired')
    assert.equal(repo.get(T, b.id)?.status, 'paid', '已支付的不能被改成过期')
  })

  test('按用户列出订单，最新在前', () => {
    order({ amountCents: 100 })
    const later = repo.create(T, {
      userId: U,
      kind: 'topup',
      amountCents: 200,
      channelId: 'ch1',
      channelType: 'yipay',
      fee: noFee,
      currency: 'USD',
      rate: 1,
      now: NOW + 5000
    })
    assert.equal(repo.listByUser(T, U)[0]!.id, later.id)
  })

  test('租户隔离：别的租户结算不了我的订单', () => {
    const o = order()
    assert.equal(repo.settle('other', o.id, { now: NOW }).ok, false)
    assert.equal(repo.get(T, o.id)?.status, 'pending')
  })
})
