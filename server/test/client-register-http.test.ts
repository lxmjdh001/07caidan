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

async function reg(body: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/client/register', payload: body as object })
  let json: any = {}
  try { json = res.json() } catch { json = {} }
  return { status: res.statusCode, json }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-reg-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// 注册接口的校验分支 HTTP 闭环：happy path 到处在跑，但重复邮箱/弱密码/邮箱格式/缺字段
// 这些拒绝分支（clientAuth.register 的 error 透传到 400）此前没在 HTTP 层测。
describe('客户端注册校验（HTTP）', () => {
  test('正常注册返回令牌', async () => {
    const r = await reg({ email: 'a@test.com', password: 'pw123456' })
    assert.equal(r.status, 200)
    assert.ok(r.json.token)
    assert.equal(r.json.user.email, 'a@test.com')
  })

  test('重复邮箱被拒（该邮箱已注册）', async () => {
    assert.equal((await reg({ email: 'dup@test.com', password: 'pw123456' })).status, 200)
    const r = await reg({ email: 'dup@test.com', password: 'other999' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, '该邮箱已注册')
  })

  test('弱密码被拒（至少 6 位）', async () => {
    const r = await reg({ email: 'weak@test.com', password: '123' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, '密码至少 6 位')
  })

  test('邮箱格式不合法被拒', async () => {
    const r = await reg({ email: 'not-an-email', password: 'pw123456' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, '邮箱格式不正确')
  })

  test('缺邮箱或密码被拒', async () => {
    assert.equal((await reg({ password: 'pw123456' })).status, 400)
    assert.equal((await reg({ email: 'x@test.com' })).status, 400)
  })
})
