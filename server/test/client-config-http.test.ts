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

// 故意配置敏感值，验证公开配置端点绝不把它们下发
function makeConfig(dbPath: string): ServerConfig {
  return {
    port: 0, host: '127.0.0.1', dbPath, mediaDir: join(dir, 'media'), tokens: [TOKEN],
    anthropicApiKey: 'sk-SECRET-ANTHROPIC', analysisModel: 'claude-opus-5', adminUser: 'admin',
    adminPassword: 'SUPER-SECRET-PW', adminTenant: TOKEN, requireEmailVerify: true, clientTenant: TOKEN,
    smtp: { host: 'smtp.secret', port: 587, user: 'u', pass: 'SMTP-SECRET', from: 'a@b.c' },
    publicUrl: 'http://localhost:8787', updatesDir: join(dir, 'updates'), crispWebsiteId: 'crisp-abc',
    metaAppId: 'fb-app-public-id', metaAppSecret: 'fb-app-secret-that-must-never-leak-123',
    metaInstagramAppId: 'ig-app-public-id', metaInstagramAppSecret: 'ig-app-secret-that-must-never-leak-123',
    metaWebhookVerifyToken: 'webhook-verify-token-that-must-never-leak',
    metaTokenEncryptionKey: 'token-encryption-key-that-must-never-leak',
    tiktokAppId: 'tiktok-app-id-that-must-never-leak',
    tiktokAppSecret: 'tiktok-app-secret-that-must-never-leak-123',
    tiktokTokenEncryptionKey: 'tiktok-token-key-that-must-never-leak-123',
    xClientId: 'x-client-id-that-must-never-leak',
    xClientSecret: 'x-client-secret-that-must-never-leak-123',
    xTokenEncryptionKey: 'x-token-key-that-must-never-leak-123',
    snapchatClientId: 'snap-client-id-that-must-never-leak',
    snapchatClientSecret: 'snap-client-secret-that-must-never-leak-123',
    snapchatTokenEncryptionKey: 'snap-token-key-that-must-never-leak-123'
  }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-cfg-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// 公开引导配置端点：免登录可取（登录前 UI 就要知道是否需要邮箱验证、Crisp 组件 ID），
// 且绝不下发任何密钥（该端点在 PUBLIC 白名单里，泄露即对全网公开）。此前没测。
describe('客户端公开配置 /api/client/config', () => {
  test('免登录可取，返回引导所需字段，绝不含任何密钥', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client/config' }) // 无 authorization 头
    assert.equal(res.statusCode, 200)
    const json = res.json()
    // 引导字段如实下发
    assert.equal(json.requireEmailVerify, true)
    assert.equal(json.crispWebsiteId, 'crisp-abc')
    // 键集钉死：一旦日后新增字段（尤其密钥类）会红，逼开发者显式判断能否公开
    assert.deepEqual(json.meta, { facebook: true, instagram: true })
    assert.equal(json.tiktok, true)
    assert.equal(json.x, true)
    assert.equal(json.snapchat, true)
    assert.deepEqual(Object.keys(json).sort(), [
      'crispWebsiteId', 'meta', 'requireEmailVerify', 'snapchat', 'tiktok', 'x'
    ])
    // 整段响应绝无任何密钥（该端点免鉴权、对全网公开）
    const raw = JSON.stringify(json)
    for (const secret of [
      'sk-SECRET-ANTHROPIC', 'SUPER-SECRET-PW', 'SMTP-SECRET', 'smtp.secret', TOKEN,
      'fb-app-public-id', 'fb-app-secret-that-must-never-leak-123',
      'ig-app-public-id', 'ig-app-secret-that-must-never-leak-123',
      'webhook-verify-token-that-must-never-leak', 'token-encryption-key-that-must-never-leak',
      'tiktok-app-id-that-must-never-leak', 'tiktok-app-secret-that-must-never-leak-123',
      'tiktok-token-key-that-must-never-leak-123',
      'x-client-id-that-must-never-leak', 'x-client-secret-that-must-never-leak-123',
      'x-token-key-that-must-never-leak-123',
      'snap-client-id-that-must-never-leak', 'snap-client-secret-that-must-never-leak-123',
      'snap-token-key-that-must-never-leak-123'
    ]) {
      assert.equal(raw.includes(secret), false, `不得泄露：${secret}`)
    }
  })
})

describe('账号代理出口检测 /api/network/diagnostic', () => {
  test('未登录不可探测；同步客户端只得到来源 IP 与时间', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/network/diagnostic' })
    assert.equal(denied.statusCode, 401)

    const result = await app.inject({
      method: 'GET',
      url: '/api/network/diagnostic',
      headers: { authorization: `Bearer ${TOKEN}` },
      remoteAddress: '203.0.113.77'
    })
    assert.equal(result.statusCode, 200)
    assert.equal(result.headers['cache-control'], 'no-store')
    const body = result.json()
    assert.equal(body.ip, '203.0.113.77')
    assert.equal(typeof body.at, 'number')
    assert.deepEqual(Object.keys(body).sort(), ['at', 'ip'])
  })
})
