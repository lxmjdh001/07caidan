import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  centsToCredits,
  creditsForUsage,
  creditsToCents,
  deductCredits,
  isModelPurpose,
  type ModelPricing
} from '../src/billing/credits.ts'

const pricing: ModelPricing = {
  creditsPerMillionInput: 300,
  creditsPerMillionOutput: 1500
}

describe('creditsForUsage', () => {
  test('按输入/输出 token 分别计价', () => {
    // 100 万输入 = 300 分，100 万输出 = 1500 分
    assert.equal(creditsForUsage({ inputTokens: 1_000_000 }, pricing), 300)
    assert.equal(creditsForUsage({ outputTokens: 1_000_000 }, pricing), 1500)
    assert.equal(
      creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing),
      1800
    )
  })

  test('小额用量向上取整 —— 不能让系统贴钱', () => {
    // 1000 输入 token = 0.3 分 → 1 分
    assert.equal(creditsForUsage({ inputTokens: 1000 }, pricing), 1)
  })

  test('语音按秒计费', () => {
    const asr: ModelPricing = {
      creditsPerMillionInput: 0,
      creditsPerMillionOutput: 0,
      creditsPerAudioSecond: 2
    }
    assert.equal(creditsForUsage({ audioSeconds: 13 }, asr), 26)
  })

  test('最低消费只在确有用量时生效', () => {
    const withMin: ModelPricing = { ...pricing, minCredits: 5 }
    assert.equal(creditsForUsage({ inputTokens: 10 }, withMin), 5)
    // 调用失败、没有任何用量时不能扣最低消费
    assert.equal(creditsForUsage({}, withMin), 0)
  })

  test('零用量不计费', () => {
    assert.equal(creditsForUsage({ inputTokens: 0, outputTokens: 0 }, pricing), 0)
  })

  test('负数用量当作 0，不会产生负积分', () => {
    assert.equal(creditsForUsage({ inputTokens: -100 }, pricing), 0)
  })
})

describe('积分与余额换算', () => {
  const rate = { creditsPerUsd: 1000 }

  test('积分换钱向上取整', () => {
    assert.equal(creditsToCents(1000, rate), 100) // 1000 分 = $1.00
    assert.equal(creditsToCents(1, rate), 1) // 0.1 分 → 向上取整 1 美分
  })

  test('钱换积分向下取整，不多送', () => {
    assert.equal(centsToCredits(100, rate), 1000)
    assert.equal(centsToCredits(15, rate), 150)
    assert.equal(centsToCredits(1, rate), 10)
    // 上面 rate=1000 下都整除，验不出取整方向。构造非整除：(50/100)*3 = 1.5 → 必须向下取整成 1。
    // 若写成 round/ceil 会给 2 —— 用户凭同样的钱多拿积分，系统贴钱。
    assert.equal(centsToCredits(50, { creditsPerUsd: 3 }), 1, '1.5 积分必须向下取整为 1，不多送')
  })

  test('非法兑换比例兜底为 1，不会除零', () => {
    assert.ok(Number.isFinite(creditsToCents(100, { creditsPerUsd: 0 })))
  })
})

function deduct(o: Partial<Parameters<typeof deductCredits>[0]> = {}) {
  return deductCredits({
    credits: 0,
    balanceCents: 0,
    cost: 0,
    autoTopUp: false,
    rate: { creditsPerUsd: 1000 },
    ...o
  })
}

describe('deductCredits', () => {
  test('积分够就直接扣，不动余额', () => {
    const r = deduct({ credits: 500, balanceCents: 10000, cost: 200 })
    assert.deepEqual(
      [r.ok, r.creditsUsed, r.centsUsed, r.credits, r.balanceCents],
      [true, 200, 0, 300, 10000]
    )
  })

  test('积分不足且未开自动补足 → 失败且分文不动', () => {
    const r = deduct({ credits: 50, balanceCents: 10000, cost: 200 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_credits')
    assert.equal(r.credits, 50, '失败时不得扣掉任何积分')
    assert.equal(r.balanceCents, 10000, '失败时不得扣掉任何余额')
  })

  test('开了自动补足：先用完积分，差额从余额兑换', () => {
    // 缺 150 分 → 150/1000 × 100 = 15 美分
    const r = deduct({ credits: 50, balanceCents: 10000, cost: 200, autoTopUp: true })
    assert.equal(r.ok, true)
    assert.equal(r.creditsUsed, 50)
    assert.equal(r.centsUsed, 15)
    assert.equal(r.credits, 0)
    assert.equal(r.balanceCents, 9985)
  })

  test('余额也不够 → 失败且分文不动（不能出现半扣状态）', () => {
    const r = deduct({ credits: 50, balanceCents: 5, cost: 200, autoTopUp: true })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_balance')
    assert.equal(r.credits, 50)
    assert.equal(r.balanceCents, 5)
  })

  test('自动补足边界：余额恰好够兑换差额时扣到 0 放行，差 1 分则失败', () => {
    // 缺 150 分 → creditsToCents(150) = 15 美分。守护是 balanceCents < needCents，
    // 「余额也不够」用例只测了远低于（5<15），恰好够(15)与差一分(14)的边界此前没测：
    // 若写成 <= 会误拒「余额恰好够付这次 AI 调用」的用户。
    const exact = deduct({ credits: 50, balanceCents: 15, cost: 200, autoTopUp: true })
    assert.equal(exact.ok, true, '余额恰好够兑换 → 放行')
    assert.equal(exact.centsUsed, 15)
    assert.equal(exact.balanceCents, 0, '恰好够 → 余额扣到 0')

    const short = deduct({ credits: 50, balanceCents: 14, cost: 200, autoTopUp: true })
    assert.equal(short.ok, false)
    assert.equal(short.reason, 'insufficient_balance')
    assert.equal(short.balanceCents, 14, '差一分即失败且分文不动')
  })

  test('零成本调用直接放行', () => {
    const r = deduct({ credits: 0, balanceCents: 0, cost: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.creditsUsed, 0)
  })

  test('积分刚好等于成本时扣到 0 而不是失败', () => {
    const r = deduct({ credits: 200, cost: 200 })
    assert.equal(r.ok, true)
    assert.equal(r.credits, 0)
  })

  test('扣费后总价值守恒（扣掉的等于消耗的）', () => {
    const before = { credits: 50, balanceCents: 10000 }
    const r = deduct({ ...before, cost: 200, autoTopUp: true })
    assert.equal(before.credits - r.credits, r.creditsUsed)
    assert.equal(before.balanceCents - r.balanceCents, r.centsUsed)
  })
})

describe('用途枚举', () => {
  test('只认三种用途', () => {
    assert.equal(isModelPurpose('asr'), true)
    assert.equal(isModelPurpose('translate'), true)
    assert.equal(isModelPurpose('autoreply'), true)
    assert.equal(isModelPurpose('mining'), false)
  })
})
