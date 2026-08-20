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

async function call(method: string, url: string, token: string | null) {
  const res = await app.inject({
    method: method as 'GET', url,
    headers: token ? { authorization: `Bearer ${token}` } : {}
  })
  return { status: res.statusCode, body: res.body }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-media-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

// 媒体端点安全：support.test 覆盖了上传→拉取正常路径，但拉媒体的安全护栏没测——
// 需鉴权、非法 mediaId 拒、未知 id 404（且路径取自租户内 DB 记录，crafted id 读不到任意文件）。
describe('/api/media/:mediaId 安全护栏', () => {
  async function registerBoss(): Promise<string> {
    return (await app.inject({
      method: 'POST', url: '/api/client/register',
      payload: { email: `b${Math.random().toString(36).slice(2)}@t.com`, password: 'pw123456' }
    })).json().token as string
  }

  test('无令牌拉媒体 → 401', async () => {
    assert.equal((await call('GET', '/api/media/anything', null)).status, 401)
  })

  test('非法 mediaId（含非法字符）→ 400 bad id', async () => {
    const token = await registerBoss()
    const r = await call('GET', '/api/media/bad%20id', token) // 空格不在 [\w.-]
    assert.equal(r.status, 400)
    assert.match(r.body, /bad id/)
  })

  test('合法格式但无此记录 → 404（不读任意文件、不泄露）', async () => {
    const token = await registerBoss()
    const r = await call('GET', '/api/media/nonexistent123.jpg', token)
    assert.equal(r.status, 404)
  })
})

describe('PUT /api/media/:mediaId 上传写入安全', () => {
  test('无令牌上传 → 401', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/media/x.jpg', payload: 'bytes',
      headers: { 'content-type': 'image/jpeg' }
    })
    assert.equal(r.statusCode, 401)
  })

  test('非法 mediaId 上传 → 400（防写到租户目录外的任意路径）', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/media/bad%20id', payload: 'bytes',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/jpeg' }
    })
    assert.equal(r.statusCode, 400)
    assert.match(r.body, /invalid mediaId/)
  })

  test('合法上传（同步令牌）→ 200，且能按同 id 取回', async () => {
    const up = await app.inject({
      method: 'PUT', url: '/api/media/e2e-up.jpg', payload: 'the-bytes',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/jpeg' }
    })
    assert.equal(up.statusCode, 200)
    const get = await app.inject({ method: 'GET', url: '/api/media/e2e-up.jpg', headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(get.statusCode, 200)
    assert.equal(get.body, 'the-bytes')
  })
})
