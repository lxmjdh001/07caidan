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

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-devlim-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// 设备配额的登录路由 wiring：device-limit.test 只测了 clientAuth 逻辑，登录接口把它
// 接进去（超限 → 403 code=device_limit + 设备列表；已在册设备放行）这条 HTTP 闭环没测。
// maxDevices 是服务端强制的付费限制。
describe('登录设备数上限（HTTP 端到端）', () => {
  const DEV_A = 'a'.repeat(16)
  const DEV_B = 'b'.repeat(16)
  const login = (deviceId: string, name: string) =>
    call('POST', '/api/client/login', null, { email: 'boss@test.com', password: 'pw123456', deviceId, deviceName: name })

  test('超设备上限的新设备登录被拒并回带设备列表，已在册设备仍可登录', async () => {
    const at = (await call('POST', '/api/login', null, { username: 'admin', password: 'admin' })).json.token
    // maxDevices=1 套餐
    const plan = (await call('POST', '/api/admin/plans', at, {
      name: '单设备', priceCents: 100, periodUnit: 'month', periodCount: 1, maxAccounts: 5, maxDevices: 1
    })).json.plan
    const token = (await call('POST', '/api/client/register', null, { email: 'boss@test.com', password: 'pw123456' })).json.token
    await call('POST', '/api/admin/balance-adjust', at, { email: 'boss@test.com', deltaCents: 1000 })
    assert.equal((await call('POST', '/api/billing/subscribe', token, { planId: plan.id })).status, 200)

    // 设备 A 登录 → 成功（占满 1 个名额）
    assert.equal((await login(DEV_A, '设备A')).status, 200)

    // 设备 B 登录 → 超限 403 device_limit，回带设备列表（含 A 供远程下线）
    const b = await login(DEV_B, '设备B')
    assert.equal(b.status, 403)
    assert.equal(b.json.code, 'device_limit')
    assert.ok(Array.isArray(b.json.devices) && b.json.devices.length >= 1, '应回带当前设备列表')

    // 设备 A 再登录 → 已在册，仍放行（不因满额把自己也挡在外）
    assert.equal((await login(DEV_A, '设备A')).status, 200)
  })

  test('无订阅（配额 0=不限）时多设备登录不受限', async () => {
    await call('POST', '/api/client/register', null, { email: 'boss@test.com', password: 'pw123456' })
    // 无订阅 → deviceQuota 0 → 不限；A、B 都能登录
    assert.equal((await login(DEV_A, '设备A')).status, 200)
    assert.equal((await login(DEV_B, '设备B')).status, 200)
  })
})
