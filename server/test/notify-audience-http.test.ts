import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'dev-token'
let dir: string
let app: FastifyInstance

function makeConfig(dbPath: string): ServerConfig {
  return {
    port: 0, host: '127.0.0.1', dbPath, mediaDir: join(dir, 'media'), tokens: [TOKEN],
    anthropicApiKey: undefined, analysisModel: 'claude-opus-5', adminUser: 'admin',
    adminPassword: 'admin', adminTenant: TOKEN, requireEmailVerify: false, clientTenant: TOKEN,
    smtp: undefined, publicUrl: 'http://localhost:8787', updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

async function call(method: string, url: string, token: string | null, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET', url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try { json = res.json() } catch { json = {} }
  return { status: res.statusCode, json }
}

async function registerBoss(email: string): Promise<string> {
  return (await call('POST', '/api/client/register', null, { email, password: 'pw123456' })).json.token
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-notif-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// /api/notices 的受众定向 HTTP 闭环：matchAudience 有单测，但路由把用户 profile
// （planId/expiresAt/registeredAt，且客服跟老板套餐走 billingUserId）接进去这条 wiring 没测。
describe('公告定向受众（HTTP 端到端）', () => {
  async function adminToken(): Promise<string> {
    return (await call('POST', '/api/login', null, { username: 'admin', password: 'admin' })).json.token
  }

  test('expiring 公告只发给订阅即将到期的老板，新用户看不到', async () => {
    const at = await adminToken()
    // 3 天期套餐 → 订阅后 expiresAt = now+3 天，落在 7 天到期窗口
    const plan = (await call('POST', '/api/admin/plans', at, {
      name: '短期', priceCents: 100, periodUnit: 'day', periodCount: 3, maxAccounts: 1, maxDevices: 0
    })).json.plan
    const tokenA = await registerBoss('expiring@test.com')
    const tokenB = await registerBoss('fresh@test.com')
    // A 充值并订阅短期套餐 → 即将到期
    await call('POST', '/api/admin/balance-adjust', at, { email: 'expiring@test.com', deltaCents: 1000 })
    assert.equal((await call('POST', '/api/billing/subscribe', tokenA, { planId: plan.id })).status, 200)

    // 建 expiring 受众公告（7 天内到期）
    await call('POST', '/api/admin/announcements', at, {
      title: '续费提醒', body: '你的套餐即将到期', audience: 'expiring', audienceParam: '7'
    })

    // A（即将到期）能看到；B（无订阅）看不到
    const seenA = (await call('GET', '/api/notices', tokenA)).json.announcements as Array<{ title: string }>
    const seenB = (await call('GET', '/api/notices', tokenB)).json.announcements as Array<{ title: string }>
    assert.ok(seenA.some((a) => a.title === '续费提醒'), 'A 应收到续费提醒')
    assert.ok(!seenB.some((a) => a.title === '续费提醒'), 'B（新用户无订阅）不应收到')
  })

  test('plan 公告只发给订阅了该套餐的老板', async () => {
    const at = await adminToken()
    const plan = (await call('POST', '/api/admin/plans', at, {
      name: '甲套餐', priceCents: 100, periodUnit: 'month', periodCount: 1, maxAccounts: 1, maxDevices: 0
    })).json.plan
    const tokenA = await registerBoss('hasplan@test.com')
    const tokenB = await registerBoss('noplan@test.com')
    await call('POST', '/api/admin/balance-adjust', at, { email: 'hasplan@test.com', deltaCents: 1000 })
    await call('POST', '/api/billing/subscribe', tokenA, { planId: plan.id })

    await call('POST', '/api/admin/announcements', at, {
      title: '甲套餐专享', body: '专享福利', audience: 'plan', audienceParam: plan.id
    })

    const seenA = (await call('GET', '/api/notices', tokenA)).json.announcements as Array<{ title: string }>
    const seenB = (await call('GET', '/api/notices', tokenB)).json.announcements as Array<{ title: string }>
    assert.ok(seenA.some((a) => a.title === '甲套餐专享'), '订户 A 应收到')
    assert.ok(!seenB.some((a) => a.title === '甲套餐专享'), '非订户 B 不应收到')
  })
})
