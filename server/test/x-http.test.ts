import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'x-test-tenant'
const ACCESS = 'X_ACCESS_TOKEN_SERVER_ONLY'
const REFRESH = 'X_REFRESH_TOKEN_SERVER_ONLY'

describe('X Direct Messages HTTP integration', () => {
  let dir: string
  let dbPath: string
  let app: FastifyInstance
  let calls: Array<{ url: string; method: string; body?: string; auth?: string }>

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  })

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init.headers)
    calls.push({
      url, method: init.method || 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
      auth: headers.get('authorization') || undefined
    })
    const parsed = new URL(url)
    if (parsed.pathname === '/2/oauth2/token') {
      assert.match(headers.get('authorization') || '', /^Basic /)
      return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200, scope: 'dm.read dm.write users.read offline.access media.write' })
    }
    assert.equal(headers.get('authorization'), `Bearer ${ACCESS}`)
    if (parsed.pathname === '/2/users/me') {
      return json({ data: { id: '100', name: 'Omni X', username: 'omni_x', profile_image_url: 'https://pbs.twimg.com/profile.jpg' } })
    }
    if (parsed.pathname === '/2/dm_events') {
      return json({
        data: [{
          id: 'dm-1', event_type: 'MessageCreate', text: 'hello x', sender_id: '200',
          dm_conversation_id: '100-200', created_at: '2026-09-04T08:00:00.000Z',
          participant_ids: ['100', '200']
        }],
        includes: { users: [{ id: '200', name: 'Alice', username: 'alice', profile_image_url: 'https://pbs.twimg.com/alice.jpg' }] },
        meta: {}
      })
    }
    if (parsed.pathname === '/2/media/upload') return json({ data: { id: 'media-1' } })
    if (parsed.pathname === '/2/dm_conversations/100-200/messages') return json({ data: { dm_event_id: 'sent-1' } })
    return json({ detail: `unexpected fake request: ${url}` }, 500)
  }

  function config(path: string): ServerConfig {
    return {
      port: 0, host: '127.0.0.1', dbPath: path, mediaDir: join(dir, 'media'),
      tokens: [TOKEN], anthropicApiKey: undefined, analysisModel: 'claude-opus-5',
      adminUser: 'admin', adminPassword: 'admin', adminTenant: TOKEN,
      requireEmailVerify: false, clientTenant: TOKEN, smtp: undefined,
      publicUrl: 'https://wzzapp.cloud', updatesDir: join(dir, 'updates'), crispWebsiteId: undefined,
      xClientId: 'x-client-id', xClientSecret: 'x-client-secret',
      xTokenEncryptionKey: 'x-token-encryption-key-at-least-32-characters'
    }
  }

  const auth = { authorization: `Bearer ${TOKEN}` }

  const connect = async () => {
    const started = await app.inject({ method: 'POST', url: '/api/x/oauth/start', headers: auth, payload: { accountId: 'x-main' } })
    assert.equal(started.statusCode, 200)
    const url = new URL(started.json().url)
    const state = url.searchParams.get('state')!
    const callback = await app.inject({ method: 'GET', url: `/oauth/x/callback?state=${encodeURIComponent(state)}&code=oauth-code` })
    assert.equal(callback.statusCode, 200)
    return { url, callback }
  }

  before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-x-')) })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    calls = []
    dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`)
    app = buildServer(config(dbPath), { xFetch: fakeFetch })
    await app.ready()
  })

  test('PKCE 网页授权后令牌加密留在主库', async () => {
    const { url, callback } = await connect()
    assert.equal(url.hostname, 'x.com')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(url.searchParams.get('code_challenge'))
    assert.match(url.searchParams.get('scope') || '', /dm\.read/)
    assert.equal(callback.body.includes(ACCESS), false)
    const db = new BetterSqlite3(dbPath)
    const row = db.prepare('SELECT access_token, refresh_token FROM x_accounts').get() as {
      access_token: string
      refresh_token: string
    }
    assert.match(row.access_token, /^v1:/)
    assert.match(row.refresh_token, /^v1:/)
    assert.equal(row.access_token.includes(ACCESS), false)
    db.close()
  })

  test('读取私信资料并发送文本和图片', async () => {
    await connect()
    const history = await app.inject({ method: 'GET', url: '/api/x/history?accountId=x-main', headers: auth })
    assert.equal(history.statusCode, 200)
    assert.deepEqual(history.json().conversations[0], {
      externalChatId: '100-200', title: 'Alice', publicId: '@alice', contactId: 'x:200',
      avatarUrl: 'https://pbs.twimg.com/alice.jpg', isGroup: false,
      updatedTime: Date.parse('2026-09-04T08:00:00.000Z'),
      messages: [{
        id: 'dm-1', event_type: 'MessageCreate', text: 'hello x', sender_id: '200',
        dm_conversation_id: '100-200', created_at: '2026-09-04T08:00:00.000Z',
        participant_ids: ['100', '200']
      }]
    })
    const sent = await app.inject({
      method: 'POST', url: '/api/x/send', headers: auth,
      payload: { accountId: 'x-main', conversationId: '100-200', text: 'reply' }
    })
    assert.deepEqual(sent.json(), { messageId: 'sent-1' })
    const image = await app.inject({
      method: 'POST', url: '/api/x/send-media', headers: auth,
      payload: {
        accountId: 'x-main', conversationId: '100-200', mimeType: 'image/jpeg',
        dataBase64: Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64'), text: 'photo'
      }
    })
    assert.deepEqual(image.json(), { messageId: 'sent-1' })
    const sendCalls = calls.filter((call) => call.url.endsWith('/messages'))
    assert.equal(JSON.parse(sendCalls.at(-1)?.body || '{}').text, 'photo')
  })

  test('未配置应用时客户端配置报告不可用', async () => {
    await app.close()
    const cfg = config(dbPath)
    delete cfg.xClientId
    app = buildServer(cfg)
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/client/config' })
    assert.equal(response.json().x, false)
  })
})
