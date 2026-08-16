import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

let dir: string
let app: FastifyInstance
let adminToken = ''
let userToken = ''
let user2Token = ''

function cfg(dbPath: string): ServerConfig {
  return {
    port: 0, host: '127.0.0.1', dbPath, mediaDir: join(dir, 'media'),
    tokens: ['dev-token'], anthropicApiKey: undefined, analysisModel: 'x',
    adminUser: 'admin', adminPassword: 'admin', adminTenant: 'dev-token',
    requireEmailVerify: false, clientTenant: 'dev-token', smtp: undefined,
    publicUrl: 'http://localhost:8787', updatesDir: join(dir, 'updates')
  }
}

async function api(method: string, url: string, body?: unknown, token: string | null = userToken) {
  const res = await app.inject({
    method: method as 'GET', url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try { json = res.json() } catch { /* */ }
  return { status: res.statusCode, json }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-support-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(cfg(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
  adminToken = (await api('POST', '/api/login', { username: 'admin', password: 'admin' }, null)).json.token
  userToken = (await api('POST', '/api/client/register', { email: 'u1@t.com', password: 'password1' }, null)).json.token
  user2Token = (await api('POST', '/api/client/register', { email: 'u2@t.com', password: 'password2' }, null)).json.token
})

describe('支持工单', () => {
  test('用户创建 → 管理员看到 → 回复 → 用户看到并追问 → 关闭', async () => {
    const t = (await api('POST', '/api/support/tickets', { title: '扫码失败', body: '一直转圈' })).json.ticket
    assert.equal(t.status, 'open')

    const adminList = (await api('GET', '/api/admin/support/tickets', undefined, adminToken)).json.tickets
    assert.equal(adminList.length, 1)

    await api('POST', `/api/support/tickets/${t.id}/messages`, { body: '请重启后重试' }, adminToken)
    let detail = (await api('GET', `/api/support/tickets/${t.id}`)).json
    assert.equal(detail.ticket.status, 'replied')
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[1].sender, 'admin')
    assert.equal(detail.messages[1].senderName, 'admin')

    // 用户追问 → 回到 open
    await api('POST', `/api/support/tickets/${t.id}/messages`, { body: '还是不行' })
    detail = (await api('GET', `/api/support/tickets/${t.id}`)).json
    assert.equal(detail.ticket.status, 'open')

    await api('POST', `/api/support/tickets/${t.id}/close`, {}, adminToken)
    assert.equal((await api('GET', `/api/support/tickets/${t.id}`)).json.ticket.status, 'closed')
  })

  test('closed 后用户追加消息 → 重新打开', async () => {
    const t = (await api('POST', '/api/support/tickets', { title: 'x', body: 'y' })).json.ticket
    await api('POST', `/api/support/tickets/${t.id}/close`)
    await api('POST', `/api/support/tickets/${t.id}/messages`, { body: '问题又出现了' })
    assert.equal((await api('GET', `/api/support/tickets/${t.id}`)).json.ticket.status, 'open')
  })

  test('用户看不到别人的工单，也不能往里发消息', async () => {
    const t = (await api('POST', '/api/support/tickets', { title: 'x', body: 'y' })).json.ticket
    assert.equal((await api('GET', `/api/support/tickets/${t.id}`, undefined, user2Token)).status, 403)
    assert.equal(
      (await api('POST', `/api/support/tickets/${t.id}/messages`, { body: 'hack' }, user2Token)).status,
      403
    )
    // 列表只有自己的
    assert.equal((await api('GET', '/api/support/tickets', undefined, user2Token)).json.tickets.length, 0)
  })

  test('无 support:manage 权限的管理员进不了工单', async () => {
    // viewer 角色没有 support:manage
    await api('POST', '/api/users', { username: 'v1', password: 'password9', role: 'viewer' }, adminToken)
    const vt = (await api('POST', '/api/login', { username: 'v1', password: 'password9' }, null)).json.token
    assert.equal((await api('GET', '/api/admin/support/tickets', undefined, vt)).status, 403)
  })

  test('open 工单排在管理员列表最前', async () => {
    const a = (await api('POST', '/api/support/tickets', { title: 'A', body: 'x' })).json.ticket
    const b = (await api('POST', '/api/support/tickets', { title: 'B', body: 'x' })).json.ticket
    await api('POST', `/api/support/tickets/${a.id}/messages`, { body: 'r' }, adminToken) // A→replied
    const list = (await api('GET', '/api/admin/support/tickets', undefined, adminToken)).json.tickets
    assert.equal(list[0].id, b.id, 'open 的 B 应排最前')
    void b
  })

  test('标题/正文校验', async () => {
    assert.equal((await api('POST', '/api/support/tickets', { title: '', body: 'x' })).status, 400)
    assert.equal((await api('POST', '/api/support/tickets', { title: 'x', body: '' })).status, 400)
    const t = (await api('POST', '/api/support/tickets', { title: 'x', body: 'y' })).json.ticket
    assert.equal((await api('POST', `/api/support/tickets/${t.id}/messages`, { body: '' })).status, 400)
  })

  test('带图消息：mediaId 随消息保存', async () => {
    // 先经媒体通道传一张"图"
    await app.inject({
      method: 'PUT', url: '/api/media/ticket-img-1',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'image/png' },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47])
    })
    const t = (await api('POST', '/api/support/tickets', { title: '截图', body: '如图', mediaId: 'ticket-img-1' })).json.ticket
    const detail = (await api('GET', `/api/support/tickets/${t.id}`)).json
    assert.equal(detail.messages[0].mediaId, 'ticket-img-1')
    // 管理员能下载
    const img = await app.inject({
      method: 'GET', url: '/api/media/ticket-img-1',
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.equal(img.statusCode, 200)
    assert.equal(img.headers['content-type'], 'image/png')
  })
})
