import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { BillingRepo } from '../src/billing/billing-repo.ts'
import { ClientAuthRepo } from '../src/client-auth.ts'
import { InviteRepo } from '../src/invite-repo.ts'
import { buildServer } from '../src/server.ts'

const TENANT = 'invite-test'
let dir: string
let app: FastifyInstance
let adminToken = ''

function config(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    tokens: [TENANT],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TENANT,
    requireEmailVerify: false,
    clientTenant: TENANT,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

async function call(method: string, url: string, token?: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try { json = res.json() } catch { /* text response */ }
  return { status: res.statusCode, json, text: res.body }
}

async function register(email: string, inviteCode?: string): Promise<string> {
  const response = await call('POST', '/api/client/register', undefined, { email, password: 'pw123456', inviteCode })
  assert.equal(response.status, 200, response.text)
  return response.json.token
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'wzz-invite-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(config(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
  adminToken = (await call('POST', '/api/login', undefined, { username: 'admin', password: 'admin' })).json.token
})

describe('邀请码注册与永久归因', () => {
  test('邀请码选填；有效邀请码绑定一次，无效邀请码拒绝', async () => {
    await register('plain@test.com')
    const inviterToken = await register('inviter@test.com')
    const dashboard = await call('GET', '/api/invites/me', inviterToken)
    assert.equal(dashboard.status, 200)
    const code = dashboard.json.codes[0].code as string

    const invalid = await call('POST', '/api/client/register', undefined, {
      email: 'bad@test.com', password: 'pw123456', inviteCode: 'NOTFOUND'
    })
    assert.equal(invalid.status, 400)
    assert.match(invalid.json.error, /邀请码/)

    await register('invitee@test.com', code.toLowerCase())
    const after = await call('GET', '/api/invites/me', inviterToken)
    assert.equal(after.json.invitedCount, 1)
    assert.equal(after.json.codes[0].usedCount, 1)
    assert.equal(after.json.referrals[0].inviteCode, code)
    assert.match(after.json.referrals[0].email, /\*/)
  })

  test('次数限制与停用立即生效，但不改已有邀请关系', async () => {
    const inviterToken = await register('owner@test.com')
    const created = await call('POST', '/api/invites', inviterToken, { code: 'LIMIT001', maxUses: 1 })
    assert.equal(created.status, 200, created.text)
    await register('one@test.com', 'LIMIT001')
    const full = await call('POST', '/api/client/register', undefined, { email: 'two@test.com', password: 'pw123456', inviteCode: 'LIMIT001' })
    assert.equal(full.status, 400)
    assert.match(full.json.error, /次数/)

    await call('PATCH', '/api/invites/LIMIT001', inviterToken, { enabled: false })
    const dashboard = await call('GET', '/api/invites/me', inviterToken)
    assert.equal(dashboard.json.referrals.length, 1, '停用邀请码不得删除既有永久关系')
  })

  test('邀请码错误不会消耗邮箱验证码', () => {
    const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}-verify.db`))
    const auth = new ClientAuthRepo(db)
    auth.issueCode('verified@test.com', '123456')
    const invalid = auth.register(TENANT, 'verified@test.com', 'pw123456', '123456', true, undefined, 'NOTFOUND')
    assert.equal(invalid.ok, false)
    assert.match(invalid.ok ? '' : invalid.error, /邀请码/)

    const valid = auth.register(TENANT, 'verified@test.com', 'pw123456', '123456', true)
    assert.equal(valid.ok, true, '邀请码校验失败后，同一邮箱验证码仍应可用于注册')
  })
})

describe('充值与消费返佣', () => {
  test('比例由管理员设置；充值和套餐消费分别返佣，重复结算不重复发放', async () => {
    const inviterToken = await register('partner@test.com')
    const code = (await call('GET', '/api/invites/me', inviterToken)).json.codes[0].code as string
    const inviteeToken = await register('customer@test.com', code)

    const setting = await call('PUT', '/api/admin/commission-settings', adminToken, { ratePercent: 10 })
    assert.equal(setting.status, 200)
    assert.equal(setting.json.rateBps, 1000)

    const channel = await call('POST', '/api/admin/channels', adminToken, {
      type: 'mock', name: 'Mock', config: { callbackSecret: 'secret' }
    })
    const order = await call('POST', '/api/billing/orders', inviteeToken, {
      kind: 'topup', amountCents: 1000, channelId: channel.json.channel.id
    })
    assert.equal(order.status, 200, order.text)
    const orderId = order.json.order.id as string
    assert.equal((await call('POST', `/api/admin/orders/${orderId}/mark-paid`, adminToken, {})).status, 200)

    const inviterBalanceAfterTopup = (await call('GET', '/api/billing/me', inviterToken)).json.balance.balanceCents
    assert.equal(inviterBalanceAfterTopup, 100, '充值 $10 × 10% = $1 佣金')

    const duplicate = await call('POST', `/api/admin/orders/${orderId}/mark-paid`, adminToken, {})
    assert.equal(duplicate.json.alreadyPaid, true)
    assert.equal((await call('GET', '/api/billing/me', inviterToken)).json.balance.balanceCents, 100)

    const plan = await call('POST', '/api/admin/plans', adminToken, {
      name: 'Starter', priceCents: 500, periodUnit: 'month', maxAccounts: 2
    })
    assert.equal((await call('POST', '/api/billing/subscribe', inviteeToken, { planId: plan.json.plan.id })).status, 200)
    assert.equal((await call('GET', '/api/billing/me', inviterToken)).json.balance.balanceCents, 150)

    const dashboard = await call('GET', '/api/invites/me', inviterToken)
    assert.equal(dashboard.json.totalCommissionCents, 150)
    assert.deepEqual(dashboard.json.commissions.map((row: any) => row.eventType).sort(), ['spend', 'topup'])

    const admin = await call('GET', '/api/admin/invites', adminToken)
    assert.equal(admin.status, 200)
    assert.equal(admin.json.referrals[0].email, 'customer@test.com')
    assert.equal(admin.json.commissions.length, 2)
  })

  test('模型额度消费即使不扣余额，也按额度价值返佣', () => {
    const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}-credits.db`))
    const auth = new ClientAuthRepo(db)
    const invites = new InviteRepo(db)
    const billing = new BillingRepo(db)
    const inviter = auth.register(TENANT, 'credit-partner@test.com', 'pw123456', undefined, false)
    assert.equal(inviter.ok, true)
    if (!inviter.ok) return
    const code = invites.ensurePersonalCode(TENANT, inviter.user.id).code
    const invitee = auth.register(TENANT, 'credit-customer@test.com', 'pw123456', undefined, false, undefined, code)
    assert.equal(invitee.ok, true)
    if (!invitee.ok) return

    invites.setRateBps(TENANT, 1000)
    assert.equal(billing.mutate(TENANT, { userId: invitee.user.id, kind: 'adjust', creditsDelta: 100 }).ok, true)
    const charged = billing.chargeCredits(TENANT, invitee.user.id, 100, {
      autoTopUp: false,
      rate: { creditsPerUsd: 1000 },
      refId: 'model-call-1'
    })
    assert.equal(charged.ok, true)
    assert.equal(billing.getBalance(TENANT, inviter.user.id).balanceCents, 1, '$0.10 模型消费 × 10% = $0.01 佣金')
    assert.equal(invites.listCommissions(TENANT, inviter.user.id)[0]?.eventType, 'spend')
  })

  test('0% 不产生佣金，管理员调账也不返佣', async () => {
    const inviterToken = await register('zero-partner@test.com')
    const code = (await call('GET', '/api/invites/me', inviterToken)).json.codes[0].code as string
    await register('zero-customer@test.com', code)
    await call('POST', '/api/admin/balance-adjust', adminToken, { email: 'zero-customer@test.com', deltaCents: 1000 })
    assert.equal((await call('GET', '/api/billing/me', inviterToken)).json.balance.balanceCents, 0)
    assert.equal((await call('GET', '/api/invites/me', inviterToken)).json.commissions.length, 0)
  })
})
