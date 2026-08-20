import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'
import { BATCH_MAX } from '../src/logs/log-repo.ts'

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

async function post(body: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/logs', payload: body as object })
  let json: any = {}
  try { json = res.json() } catch { json = {} }
  return { status: res.statusCode, json }
}

const DEV = 'a1b2c3d4e5f6' // 合法：12 位 hex
const entry = () => ({ level: 'warn', scope: 't', message: 'm', at: 1 })

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-log-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// /api/logs 是公开端点（免鉴权，游客也能上报），其输入校验是防滥用/DoS 红线，此前没测。
describe('/api/logs 输入校验（公开端点防滥用）', () => {
  test('缺 deviceId 或格式非法（非 8-64 位 hex）→ 400', async () => {
    assert.equal((await post({ entries: [entry()] })).status, 400) // 缺
    assert.equal((await post({ deviceId: '123', entries: [entry()] })).status, 400) // 太短
    assert.equal((await post({ deviceId: 'nothex!!', entries: [entry()] })).status, 400) // 非 hex
    assert.equal((await post({ deviceId: 'a'.repeat(65), entries: [entry()] })).status, 400) // 太长
  })

  test('entries 非数组 → 400', async () => {
    assert.equal((await post({ deviceId: DEV })).status, 400)
    assert.equal((await post({ deviceId: DEV, entries: 'nope' })).status, 400)
  })

  test('单批超过 BATCH_MAX → 400（防一次塞爆）', async () => {
    const over = Array.from({ length: BATCH_MAX + 1 }, entry)
    const r = await post({ deviceId: DEV, entries: over })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /单批最多/)
  })

  test('合法上报（游客，无令牌）→ 200 added', async () => {
    const r = await post({ deviceId: DEV, entries: [entry(), entry()] })
    assert.equal(r.status, 200)
    assert.equal(r.json.added, 2)
  })
})
