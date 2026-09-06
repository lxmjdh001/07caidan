import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import {
  parseCorsOrigins,
  productionConfigErrors,
  type ServerConfig
} from '../src/config.ts'
import { buildServer } from '../src/server.ts'
import { FixedWindowRateLimiter } from '../src/security/rate-limiter.ts'

const dirs: string[] = []
const apps: FastifyInstance[] = []

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'omni-production-security-'))
  dirs.push(dir)
  return {
    production: false,
    port: 0,
    host: '127.0.0.1',
    dbPath: join(dir, 'omnichat.db'),
    mediaDir: join(dir, 'media'),
    tokens: ['a-secure-random-sync-token-123456'],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'strong-admin-password',
    adminTenant: 'tenant',
    requireEmailVerify: false,
    clientTenant: 'tenant',
    smtp: undefined,
    publicUrl: 'https://wzzapp.cloud',
    trustProxy: true,
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined,
    ...overrides
  }
}

function server(overrides: Partial<ServerConfig> = {}): FastifyInstance {
  const app = buildServer(config(overrides))
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('生产配置安全边界', () => {
  test('生产默认不开放跨域，开发只开放本机来源', () => {
    assert.deepEqual(parseCorsOrigins(undefined, true), [])
    assert.ok(parseCorsOrigins(undefined, false).includes('http://localhost:5173'))
    assert.deepEqual(parseCorsOrigins('https://a.example, https://a.example,https://b.example', true), [
      'https://a.example',
      'https://b.example'
    ])
  })

  test('拒绝默认口令、弱令牌、明文公网地址和公网监听', () => {
    const errors = productionConfigErrors(config({
      host: '0.0.0.0',
      publicUrl: 'http://example.com',
      adminPassword: 'admin',
      tokens: ['dev-token'],
      requireEmailVerify: true,
      corsOrigins: ['*']
    }))
    assert.ok(errors.length >= 5)
  })

  test('当前标准 Caddy 部署配置可通过校验', () => {
    assert.deepEqual(productionConfigErrors(config()), [])
  })
})

describe('公开接口防护', () => {
  test('公开路径采用精确匹配，近似路径仍需鉴权', async () => {
    const app = server()
    const res = await app.inject({ method: 'POST', url: '/api/login-anything', payload: {} })
    assert.equal(res.statusCode, 401)
  })

  test('登录接口超过窗口上限返回 429 与 Retry-After', async () => {
    const app = server()
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '203.0.113.8',
        payload: { username: 'nobody', password: 'wrong-password' }
      })
      assert.equal(res.statusCode, 401)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: '203.0.113.8',
      payload: { username: 'nobody', password: 'wrong-password' }
    })
    assert.equal(blocked.statusCode, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
  })

  test('生产无 SMTP 时不会签发固定找回密码验证码', async () => {
    const app = server({ production: true })
    const registered = await app.inject({
      method: 'POST',
      url: '/api/client/register',
      payload: { email: 'owner@example.com', password: 'safe-password-123' }
    })
    assert.equal(registered.statusCode, 200)
    const requested = await app.inject({
      method: 'POST',
      url: '/api/client/forgot-password',
      payload: { email: 'owner@example.com' }
    })
    assert.equal(requested.statusCode, 200)
    const reset = await app.inject({
      method: 'POST',
      url: '/api/client/reset-password',
      payload: { email: 'owner@example.com', code: '12345', password: 'changed-password-456' }
    })
    assert.equal(reset.statusCode, 400)
  })
})

describe('限流器', () => {
  test('窗口结束后恢复，且不同键互不影响', () => {
    const limiter = new FixedWindowRateLimiter()
    assert.equal(limiter.consume('a', 1, 1_000, 1_000).allowed, true)
    assert.equal(limiter.consume('a', 1, 1_000, 1_100).allowed, false)
    assert.equal(limiter.consume('b', 1, 1_000, 1_100).allowed, true)
    assert.equal(limiter.consume('a', 1, 1_000, 2_001).allowed, true)
  })
})
