import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { BillingRepo, type Plan } from '../src/billing/billing-repo.ts'
import { openDb } from '../src/db.ts'

const T = 'tenant-1'
const U = 42
const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0)
const RATE = { creditsPerUsd: 1000 }

let dir: string
let repo: BillingRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-billing-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  repo = new BillingRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
})

function plan(o: Partial<Parameters<BillingRepo['createPlan']>[1]> = {}): Plan {
  return repo.createPlan(T, {
    name: '基础版',
    priceCents: 3000,
    periodUnit: 'month',
    maxAccounts: 10,
    ...o
  })
}

/** 充值，作为后续用例的前置 */
function topup(cents: number): void {
  repo.mutate(T, { userId: U, kind: 'topup', amountCents: cents, now: NOW })
}

describe('套餐管理', () => {
  test('创建后可查询，价格与周期正确落库', () => {
    const p = plan({ priceCents: 9900, periodUnit: 'year', maxAccounts: 100 })
    const got = repo.getPlan(T, p.id)
    assert.equal(got?.priceCents, 9900)
    assert.equal(got?.periodUnit, 'year')
    assert.equal(got?.maxAccounts, 100)
  })

  test('列表按 sortOrder 排序，可只取启用的', () => {
    plan({ name: 'B', sortOrder: 2 })
    plan({ name: 'A', sortOrder: 1 })
    const off = plan({ name: 'C', sortOrder: 3, enabled: false })
    assert.deepEqual(
      repo.listPlans(T).map((p) => p.name),
      ['A', 'B', 'C']
    )
    assert.equal(repo.listPlans(T, true).length, 2)
    assert.equal(repo.getPlan(T, off.id)?.enabled, false)
  })

  test('停用而不是删除 —— 历史订阅还引用着它', () => {
    const p = plan()
    assert.equal(repo.disablePlan(T, p.id), true)
    assert.equal(repo.getPlan(T, p.id)?.enabled, false)
  })

  test('负价格与非法周期数被规整', () => {
    const p = plan({ priceCents: -100, periodCount: 0 })
    assert.equal(p.priceCents, 0)
    assert.equal(p.periodCount, 1)
  })

  test('租户隔离', () => {
    plan()
    assert.equal(repo.listPlans('other').length, 0)
  })
})

describe('余额与流水', () => {
  test('新用户余额为 0', () => {
    assert.deepEqual(repo.getBalance(T, U), { userId: U, balanceCents: 0, credits: 0 })
  })

  test('充值后余额增加且留下流水', () => {
    topup(10000)
    assert.equal(repo.getBalance(T, U).balanceCents, 10000)
    const rows = repo.listLedger(T, U)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.kind, 'topup')
    assert.equal(rows[0]!.balanceAfter, 10000)
  })

  test('默认不允许透支：扣超了整笔失败且分文不动', () => {
    topup(100)
    const r = repo.mutate(T, { userId: U, kind: 'plan_purchase', amountCents: -500, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_balance')
    assert.equal(repo.getBalance(T, U).balanceCents, 100)
    assert.equal(repo.listLedger(T, U).length, 1, '失败不得写流水')
  })

  test('积分同样不允许扣成负数', () => {
    const r = repo.mutate(T, { userId: U, kind: 'model_usage', creditsDelta: -10, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_credits')
  })

  test('显式允许时可以为负（对账冲正等场景）', () => {
    const r = repo.mutate(T, {
      userId: U,
      kind: 'adjust',
      amountCents: -500,
      allowNegative: true,
      now: NOW
    })
    assert.equal(r.ok, true)
    assert.equal(r.balance.balanceCents, -500)
  })

  test('对账：流水累加恒等于当前余额', () => {
    topup(10000)
    repo.mutate(T, { userId: U, kind: 'plan_purchase', amountCents: -3000, now: NOW })
    repo.exchangeCredits(T, U, 1000, RATE, NOW)
    const audit = repo.auditBalance(T, U)
    assert.equal(audit.consistent, true)
    assert.deepEqual(audit.fromLedger, audit.stored)
  })

  test('流水按时间倒序返回', () => {
    repo.mutate(T, { userId: U, kind: 'topup', amountCents: 100, now: NOW })
    repo.mutate(T, { userId: U, kind: 'topup', amountCents: 200, now: NOW + 1000 })
    assert.equal(repo.listLedger(T, U)[0]!.amountCents, 200)
  })
})

describe('翻译字符与赠送端口', () => {
  test('免费用户永久 10 端口，赠送端口在基础额度上累加', () => {
    assert.equal(repo.accountQuota(T, U, NOW), 10)
    const gift = repo.mutateEntitlements(T, {
      userId: U,
      kind: 'admin_gift',
      charactersDelta: 20_000,
      portsDelta: 7,
      note: '活动赠送',
      now: NOW
    })
    assert.equal(gift.ok, true)
    assert.deepEqual(repo.getEntitlements(T, U), { userId: U, characters: 20_000, bonusPorts: 7 })
    assert.equal(repo.accountQuota(T, U, NOW), 17)
    assert.equal(repo.listEntitlementLedger(T, U)[0]?.kind, 'admin_gift')
  })

  test('VIP1/VIP2 端口由套餐配置，VIP3 的 0 表示无限制', () => {
    const vip1 = plan({ tier: 'vip1', maxAccounts: 200, includedCharacters: 1000, priceCents: 0 })
    repo.changePlan(T, U, vip1.id, NOW)
    assert.equal(repo.accountQuota(T, U, NOW), 200)
    assert.equal(repo.getEntitlements(T, U).characters, 1000)

    repo.mutateEntitlements(T, { userId: U, kind: 'admin_gift', portsDelta: 5, now: NOW + 1 })
    assert.equal(repo.accountQuota(T, U, NOW + 1), 205)

    const vip3 = plan({ tier: 'vip3', maxAccounts: 0, priceCents: 0 })
    repo.changePlan(T, U, vip3.id, NOW + 2)
    assert.equal(repo.accountQuota(T, U, NOW + 2), 0)
    assert.equal(repo.checkAccountQuota(T, U, 100_000, NOW + 2).canAddMore, true)
  })

  test('成功翻译按输入输出 Token 与引擎系数扣费；requestId 重试幂等', () => {
    repo.mutateEntitlements(T, { userId: U, kind: 'admin_gift', charactersDelta: 10, now: NOW })
    const first = repo.chargeTranslation(T, {
      userId: U,
      actorUserId: U,
      requestId: 'translation-1',
      inputTokens: 10,
      outputTokens: 10,
      engine: 'google-free',
      channel: 'telegram',
      direction: 'out',
      now: NOW + 1
    })
    assert.equal(first.ok, true)
    assert.equal(first.remaining, 6)

    const duplicate = repo.chargeTranslation(T, {
      userId: U,
      actorUserId: U,
      requestId: 'translation-1',
      inputTokens: 10,
      outputTokens: 10,
      now: NOW + 2
    })
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.remaining, 6)

    const insufficient = repo.chargeTranslation(T, {
      userId: U,
      actorUserId: U,
      requestId: 'translation-2',
      inputTokens: 20,
      outputTokens: 20,
      engine: 'google-free',
      now: NOW + 3
    })
    assert.equal(insufficient.ok, false)
    assert.equal(repo.getEntitlements(T, U).characters, 6)
    assert.equal(repo.listEntitlementLedger(T, U).filter((r) => r.kind === 'translation_usage').length, 1)
    assert.deepEqual(repo.translationUsageSummary(T, U), {
      totalTokens: 4,
      totalTranslations: 1,
      byEngine: [{ engine: 'google-free', tokens: 4, calls: 1 }],
      byChannel: [{ channel: 'telegram', tokens: 4, calls: 1 }],
      recent: [{
        userId: U,
        requestId: 'translation-1',
        engine: 'google-free',
        channel: 'telegram',
        direction: 'out',
        inputTokens: 10,
        outputTokens: 10,
        billedTokens: 4,
        createdAt: NOW + 1
      }]
    })
  })

  test('余额按后台比例兑换字符并留下两套账本', () => {
    topup(500)
    const result = repo.purchaseCharacters(T, U, 200, 12_000, NOW + 1)
    assert.equal(result.ok, true)
    assert.equal(result.characters, 24_000)
    assert.equal(result.balance.balanceCents, 300)
    assert.equal(result.entitlements.characters, 24_000)
    assert.equal(repo.listLedger(T, U)[0]?.kind, 'character_purchase')
    assert.equal(repo.listEntitlementLedger(T, U)[0]?.kind, 'character_purchase')
  })

  test('管理员重复保存同一有效套餐不会重复赠送字符', () => {
    const vip = plan({ tier: 'vip2', maxAccounts: 1000, includedCharacters: 5000, priceCents: 0 })
    repo.setSubscriptionByAdmin(T, U, { planId: vip.id }, NOW)
    repo.setSubscriptionByAdmin(T, U, { planId: vip.id, autoRenew: true }, NOW + 1000)
    assert.equal(repo.getEntitlements(T, U).characters, 5000)
    assert.equal(repo.listEntitlementLedger(T, U).filter((r) => r.kind === 'plan_grant').length, 1)
  })

  test('不同用户可复用同一 requestId，各自正常扣费', () => {
    const other = U + 1
    repo.mutateEntitlements(T, { userId: U, kind: 'admin_gift', charactersDelta: 10, now: NOW })
    repo.mutateEntitlements(T, { userId: other, kind: 'admin_gift', charactersDelta: 10, now: NOW })
    const input = { actorUserId: U, requestId: 'shared-platform-message', inputTokens: 2, outputTokens: 1, now: NOW + 1 }
    assert.equal(repo.chargeTranslation(T, { ...input, userId: U }).ok, true)
    assert.equal(repo.chargeTranslation(T, { ...input, userId: other, actorUserId: other }).ok, true)
    assert.equal(repo.getEntitlements(T, U).characters, 7)
    assert.equal(repo.getEntitlements(T, other).characters, 7)
  })
})

describe('购买与升降级', () => {
  test('有效套餐不能重复购买，升降级也不会重复领取套餐字符', () => {
    const basic = plan({ priceCents: 0, includedCharacters: 1000 })
    const pro = plan({ priceCents: 0, includedCharacters: 5000 })
    assert.equal(repo.changePlan(T, U, basic.id, NOW).ok, true)
    const repeat = repo.changePlan(T, U, basic.id, NOW + 1)
    assert.equal(repeat.ok, false)
    assert.equal(repeat.ok === false && repeat.reason, 'already_subscribed')
    assert.equal(repo.changePlan(T, U, pro.id, NOW + 2).ok, true)
    assert.equal(repo.getEntitlements(T, U).characters, 1000)
  })

  test('余额够就扣款并生成订阅', () => {
    const p = plan({ priceCents: 3000 })
    topup(10000)
    const r = repo.changePlan(T, U, p.id, NOW)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.net, 3000)
    assert.equal(r.balance.balanceCents, 7000)
    assert.equal(r.subscription.expiresAt, NOW + 30 * DAY)
    assert.equal(repo.accountQuota(T, U, NOW), 10)
  })

  test('余额不足整笔失败，不留半成品订阅', () => {
    const p = plan({ priceCents: 3000 })
    topup(100)
    const r = repo.changePlan(T, U, p.id, NOW)
    assert.equal(r.ok, false)
    assert.equal(repo.getSubscription(T, U), null, '失败不得写订阅')
    assert.equal(repo.getBalance(T, U).balanceCents, 100)
  })

  test('余额恰好等于应付净额：扣到 0 成功（护栏是 < net，不能误拒恰好够）', () => {
    // 常见真实流程：用户充值到恰好一个套餐价再订阅。changePlan 预检是
    // balanceCents < net，恰好相等应放行、扣到 0。既有用例只测远够(10000)与
    // 远不够(100)，这条零点边界没测——若写成 <= 会拒掉"钱刚好够买"的用户。
    const p = plan({ priceCents: 3000 })
    topup(3000)
    const r = repo.changePlan(T, U, p.id, NOW)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.net, 3000)
    assert.equal(r.balance.balanceCents, 0, '恰好够 → 余额扣到 0')
    assert.equal(repo.getSubscription(T, U)?.planId, p.id, '订阅已生成')
  })

  test('升级：旧套餐按剩余天数折算退回，只补差价', () => {
    const basic = plan({ name: '基础', priceCents: 3000, maxAccounts: 10 })
    const pro = plan({ name: '专业', priceCents: 30000, periodUnit: 'year', maxAccounts: 100 })
    topup(100000)
    repo.changePlan(T, U, basic.id, NOW)

    // 用了 15 天后升级
    const later = NOW + 15 * DAY
    const r = repo.changePlan(T, U, pro.id, later)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.creditFromOld, 1500, '3000 × 15/30')
    assert.equal(r.net, 30000 - 1500)
    // 100000 - 3000(基础) + 1500(折算退回) - 30000(专业)
    assert.equal(r.balance.balanceCents, 68500)
    assert.equal(repo.accountQuota(T, U, later), 100)
  })

  test('降级：差额退回余额，净额为负', () => {
    const pro = plan({ name: '专业', priceCents: 30000, periodUnit: 'year', maxAccounts: 100 })
    const basic = plan({ name: '基础', priceCents: 3000, maxAccounts: 10 })
    topup(30000)
    repo.changePlan(T, U, pro.id, NOW)
    assert.equal(repo.getBalance(T, U).balanceCents, 0)

    const later = NOW + 65 * DAY
    const r = repo.changePlan(T, U, basic.id, later)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.net < 0, '降级应为净退款')
    // 剩 300 天：30000 × 300/365 = 24657（向下取整）
    assert.equal(r.creditFromOld, 24657)
    assert.equal(r.balance.balanceCents, 24657 - 3000)
  })

  test('折算退款与新套餐扣款分成两条流水，账面看得清', () => {
    const a = plan({ priceCents: 3000 })
    const b = plan({ priceCents: 5000 })
    topup(20000)
    repo.changePlan(T, U, a.id, NOW)
    repo.changePlan(T, U, b.id, NOW + 10 * DAY)
    const kinds = repo.listLedger(T, U).map((r) => r.kind)
    assert.ok(kinds.includes('proration_refund'))
    assert.equal(kinds.filter((k) => k === 'plan_purchase').length, 2)
    assert.equal(repo.auditBalance(T, U).consistent, true)
  })

  test('不存在或已停用的套餐买不了', () => {
    topup(10000)
    assert.equal(repo.changePlan(T, U, 'nope', NOW).ok, false)
    const off = plan({ enabled: false })
    const r = repo.changePlan(T, U, off.id, NOW)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'plan_disabled')
  })

  test('免费套餐（0 元）也能订阅', () => {
    const free = plan({ priceCents: 0, maxAccounts: 1 })
    const r = repo.changePlan(T, U, free.id, NOW)
    assert.equal(r.ok, true)
    assert.equal(repo.accountQuota(T, U, NOW), 1)
  })
})

describe('自动续费与到期', () => {
  test('余额够则顺延一个周期', () => {
    const p = plan({ priceCents: 3000 })
    topup(10000)
    repo.changePlan(T, U, p.id, NOW)
    repo.setAutoRenew(T, U, true)

    const due = NOW + 30 * DAY
    assert.equal(repo.renew(T, U, due).ok, true)
    const sub = repo.getSubscription(T, U)
    assert.equal(sub?.expiresAt, due + 30 * DAY, '在原到期时间上顺延')
    assert.equal(sub?.status, 'active')
    assert.equal(repo.getBalance(T, U).balanceCents, 4000)
  })

  test('余额不足则标记过期，不产生欠费', () => {
    const p = plan({ priceCents: 3000 })
    topup(3000)
    repo.changePlan(T, U, p.id, NOW)
    const r = repo.renew(T, U, NOW + 30 * DAY)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_balance')
    assert.equal(repo.getSubscription(T, U)?.status, 'expired')
    assert.equal(repo.getBalance(T, U).balanceCents, 0, '不得扣成负数')
  })

  test('过期后回落到永久免费 10 端口', () => {
    const p = plan({ priceCents: 0, maxAccounts: 10 })
    repo.changePlan(T, U, p.id, NOW)
    assert.equal(repo.accountQuota(T, U, NOW), 10)
    assert.equal(repo.accountQuota(T, U, NOW + 31 * DAY), 10, '到期后保留免费用户端口')
  })

  test('expireIfDue 只对已到期的生效', () => {
    const p = plan({ priceCents: 0 })
    repo.changePlan(T, U, p.id, NOW)
    assert.equal(repo.expireIfDue(T, U, NOW + DAY), false)
    assert.equal(repo.expireIfDue(T, U, NOW + 31 * DAY), true)
  })

  test('账号数超限时禁止新增但不踢下线', () => {
    const p = plan({ priceCents: 0, maxAccounts: 5 })
    repo.changePlan(T, U, p.id, NOW)
    const s = repo.checkAccountQuota(T, U, 8, NOW)
    assert.equal(s.withinQuota, false)
    assert.equal(s.canAddMore, false)
    assert.equal(s.overBy, 3)
  })
})

describe('积分', () => {
  test('余额兑换积分', () => {
    topup(10000)
    const r = repo.exchangeCredits(T, U, 1000, RATE, NOW)
    assert.equal(r.ok, true)
    assert.equal(r.balance.balanceCents, 9000)
    // 1000 分 = $10，按 1000 积分/美元 → 10000 积分
    assert.equal(r.balance.credits, 10000)
  })

  test('兑换积分非整除时向下取整，不多送（真实兑换路径）', () => {
    // 上面用 RATE=1000、整额，恒整除，验不出取整方向。exchangeCredits 内联了自己的 floor，
    // 与纯函数 centsToCredits 是两条路径，必须单独钉死：(50/100)*3 = 1.5 → 只给 1 积分。
    // 若这条写成 round/ceil，用户凭 50 分能多兑出 1 个积分、系统贴钱。
    topup(10000)
    const r = repo.exchangeCredits(T, U, 50, { creditsPerUsd: 3 }, NOW)
    assert.equal(r.ok, true)
    assert.equal(r.balance.credits, 1, '1.5 向下取整为 1')
    assert.equal(r.balance.balanceCents, 9950, '扣掉兑换用的 50 分')
  })

  test('积分够时只扣积分', () => {
    topup(10000)
    repo.exchangeCredits(T, U, 1000, RATE, NOW)
    const r = repo.chargeCredits(T, U, 30, { autoTopUp: false, rate: RATE, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.balance.credits, 9970)
    assert.equal(r.balance.balanceCents, 9000, '未开自动补足时不动余额')
  })

  test('积分不足且未开自动补足则失败', () => {
    topup(10000)
    const r = repo.chargeCredits(T, U, 30, { autoTopUp: false, rate: RATE, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'insufficient_credits')
    assert.equal(repo.getBalance(T, U).balanceCents, 10000)
  })

  test('开了自动补足则从余额兑换差额', () => {
    topup(10000)
    const r = repo.chargeCredits(T, U, 30, { autoTopUp: true, rate: RATE, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.balance.credits, 0)
    // 30 积分 = 3 美分
    assert.equal(r.balance.balanceCents, 9997)
  })

  test('余额与积分都不足则失败且分文不动', () => {
    const r = repo.chargeCredits(T, U, 1000, { autoTopUp: true, rate: RATE, now: NOW })
    assert.equal(r.ok, false)
    assert.deepEqual(repo.getBalance(T, U), { userId: U, balanceCents: 0, credits: 0 })
    assert.equal(repo.listLedger(T, U).length, 0)
  })

  test('一连串操作后账仍然是平的', () => {
    const p = plan({ priceCents: 3000 })
    topup(50000)
    repo.changePlan(T, U, p.id, NOW)
    repo.exchangeCredits(T, U, 2000, RATE, NOW)
    repo.chargeCredits(T, U, 50, { autoTopUp: true, rate: RATE, now: NOW })
    repo.chargeCredits(T, U, 100, { autoTopUp: true, rate: RATE, now: NOW })
    assert.equal(repo.auditBalance(T, U).consistent, true)
  })
})
