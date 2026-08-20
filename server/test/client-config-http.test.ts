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
    publicUrl: 'http://localhost:8787', updatesDir: join(dir, 'updates'), crispWebsiteId: 'crisp-abc'
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
    assert.deepEqual(Object.keys(json).sort(), ['crispWebsiteId', 'requireEmailVerify'])
    // 整段响应绝无任何密钥（该端点免鉴权、对全网公开）
    const raw = JSON.stringify(json)
    for (const secret of ['sk-SECRET-ANTHROPIC', 'SUPER-SECRET-PW', 'SMTP-SECRET', 'smtp.secret', TOKEN]) {
      assert.equal(raw.includes(secret), false, `不得泄露：${secret}`)
    }
  })
})
