import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

// 管理后台是独立前端(admin/)，改/删走跨域 PATCH/DELETE，浏览器先发 OPTIONS 预检。
// @fastify/cors 默认 methods 只有 GET,HEAD,POST —— 少了 PATCH/DELETE 预检就失败，
// 浏览器根本不发正式请求「且界面无任何报错」(套餐停用/订单标记/日志级别设置全静默失灵)。
// 这条守住 CORS 放行方法集：谁把 server.ts 的 methods 数组删了(退回默认)，这里立刻转红。
describe('CORS 预检放行改删方法', () => {
  let dir: string
  let app: FastifyInstance

  function makeConfig(dbPath: string): ServerConfig {
    return {
      port: 0,
      host: '127.0.0.1',
      dbPath,
      mediaDir: join(dir, 'media'),
      tokens: ['dev-token'],
      anthropicApiKey: undefined,
      analysisModel: 'claude-opus-5',
      adminUser: 'admin',
      adminPassword: 'admin',
      adminTenant: 'dev-token',
      requireEmailVerify: false,
      clientTenant: 'dev-token',
      smtp: undefined,
      publicUrl: 'http://localhost:8787',
      updatesDir: join(dir, 'updates'),
      crispWebsiteId: undefined
    }
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-cors-'))
  })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
    await app.ready()
  })

  // 逐个方法模拟浏览器预检：OPTIONS + Origin + Access-Control-Request-Method
  for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
    test(`预检 ${method} 被放行且回显到 allow-methods`, async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/campaigns/anything',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method
        }
      })
      // 预检成功(2xx，@fastify/cors 默认 204)
      assert.ok(res.statusCode >= 200 && res.statusCode < 300, `预检返回 ${res.statusCode}`)
      const allow = String(res.headers['access-control-allow-methods'] ?? '')
      assert.ok(allow.includes(method), `allow-methods=「${allow}」缺 ${method} → 浏览器会静默拦死`)
      // 仅白名单来源回显请求 Origin
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173')
    })
  }

  test('allow-methods 同时含读写全集(GET/POST/PATCH/DELETE)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/campaigns/x',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PATCH' }
    })
    const allow = String(res.headers['access-control-allow-methods'] ?? '')
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
      assert.ok(allow.includes(m), `allow-methods 缺 ${m}`)
    }
  })

  test('未知网站不能跨域调用 API', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/campaigns/x',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'PATCH'
      }
    })
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })
})
