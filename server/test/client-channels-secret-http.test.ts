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
  return { status: res.statusCode, json, raw: res.body }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-chsec-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// 红线：客户端可购通道列表（/api/billing/channels）绝不下发支付网关密钥。channel-secret-masked
// 测的是后台端点打码，客户端这个「老板拉可付通道」的端点整体排除密钥（连 config 都不给）此前没测。
describe('客户端可购支付通道 /api/billing/channels 不泄密', () => {
  test('老板拉到通道用于付款，但绝无回调密钥/config', async () => {
    const at = (await call('POST', '/api/login', null, { username: 'admin', password: 'admin' })).json.token
    const RAW = 'callback-TOPSECRET-value-9x7'
    await call('POST', '/api/admin/channels', at, {
      type: 'mock', name: '带密钥通道', currency: 'USD',
      config: { callbackSecret: RAW, apiKey: 'sk-CH-SECRET' }
    })
    const token = (await call('POST', '/api/client/register', null, { email: 'boss@test.com', password: 'pw123456' })).json.token

    const r = await call('GET', '/api/billing/channels', token)
    assert.equal(r.status, 200)
    const chans = r.json.channels as Array<Record<string, unknown>>
    const mine = chans.find((c) => c.name === '带密钥通道')
    assert.ok(mine, '老板应能看到该通道用于付款')
    // 通道对象键集钉死：只有付款所需字段，绝无 config/密钥
    assert.deepEqual(
      Object.keys(mine!).sort(),
      ['currency', 'feeFixedCents', 'feePaidBy', 'feeRate', 'id', 'name', 'type'].sort()
    )
    // 整段响应不含任何密钥原文或密钥字段名
    for (const leak of [RAW, 'sk-CH-SECRET', 'callbackSecret', 'apiKey', 'config']) {
      assert.equal(r.raw.includes(leak), false, `不得泄露：${leak}`)
    }
  })
})
