import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'snap-test-tenant'
const ACCESS = 'SNAP_ACCESS_SERVER_ONLY'
const REFRESH = 'SNAP_REFRESH_SERVER_ONLY'
const BRAND = 'brand-profile-0001'
const CREATOR = 'creator-profile-0001'

describe('Snapchat Public Profile Messaging HTTP integration', () => {
  let dir: string
  let dbPath: string
  let app: FastifyInstance
  let calls: Array<{ url: string; method: string; body?: string }>

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  })
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : undefined })
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/login/oauth2/access_token')) {
      return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: 'snapchat-profile-api' })
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${ACCESS}`)
    if (parsed.pathname === '/v1/public_profiles/my_profile') {
      return json({ public_profile: { profile_id: BRAND, display_name: 'Omni Brand', username: 'omni_brand', profile_image_url: 'https://cf-st.sc-cdn.net/brand.jpg' } })
    }
    if (parsed.pathname === `/v1/public_profiles/${CREATOR}`) {
      return json({ public_profile: { profile_id: CREATOR, display_name: 'Creator Alice', username: 'alice_snap', profile_image_url: 'https://cf-st.sc-cdn.net/alice.jpg' } })
    }
    if (parsed.pathname.endsWith('/group_conversation')) {
      assert.equal(parsed.searchParams.get('creator_profile_id'), CREATOR)
      return json({ group_conversation: { conversation_id: 'conversation-1', token: 'CONVERSATION_TOKEN_SERVER_ONLY' } })
    }
    if (parsed.pathname.endsWith('/group_conversation_messages') && (init.method || 'GET') === 'POST') {
      return json({
        group_conversation_messages: [{
          sub_request_status: 'SUCCESS',
          group_conversation_message: { message_id: 'sent-snap-1', type: 'TEXT', text_message: 'reply' }
        }]
      })
    }
    if (parsed.pathname.endsWith('/group_conversation_messages')) {
      assert.equal(parsed.searchParams.get('token'), 'CONVERSATION_TOKEN_SERVER_ONLY')
      return json({
        group_conversation_messages: [{
          sub_request_status: 'SUCCESS',
          group_conversation_message: {
            message_id: 'in-snap-1', type: 'TEXT', text_message: 'hello snap',
            sender_profile_id: CREATOR, created_at: '2026-09-04T08:00:00Z'
          }
        }]
      })
    }
    return json({ request_status: 'ERROR', message: `unexpected fake request: ${url}` }, 500)
  }

  function config(path: string): ServerConfig {
    return {
      port: 0, host: '127.0.0.1', dbPath: path, mediaDir: join(dir, 'media'),
      tokens: [TOKEN], anthropicApiKey: undefined, analysisModel: 'claude-opus-5',
      adminUser: 'admin', adminPassword: 'admin', adminTenant: TOKEN,
      requireEmailVerify: false, clientTenant: TOKEN, smtp: undefined,
      publicUrl: 'https://wzzapp.cloud', updatesDir: join(dir, 'updates'), crispWebsiteId: undefined,
      snapchatClientId: 'snap-client-id', snapchatClientSecret: 'snap-client-secret',
      snapchatTokenEncryptionKey: 'snap-token-encryption-key-at-least-32-characters'
    }
  }
  const auth = { authorization: `Bearer ${TOKEN}` }

  const connect = async () => {
    const started = await app.inject({
      method: 'POST', url: '/api/snapchat/oauth/start', headers: auth, payload: { accountId: 'snap-main' }
    })
    assert.equal(started.statusCode, 200)
    const url = new URL(started.json().url)
    const callback = await app.inject({
      method: 'GET', url: `/oauth/snapchat/callback?state=${url.searchParams.get('state')}&code=oauth-code`
    })
    assert.equal(callback.statusCode, 200)
    return { url, callback }
  }

  before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-snap-')) })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    calls = []
    dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`)
    app = buildServer(config(dbPath), { snapchatFetch: fakeFetch })
    await app.ready()
  })

  test('网页授权公共主页并加密保存令牌', async () => {
    const { url, callback } = await connect()
    assert.equal(url.hostname, 'accounts.snapchat.com')
    assert.equal(url.searchParams.get('scope'), 'snapchat-profile-api')
    assert.equal(callback.body.includes(ACCESS), false)
    const db = new BetterSqlite3(dbPath)
    const row = db.prepare('SELECT access_token, refresh_token FROM snapchat_accounts').get() as {
      access_token: string
      refresh_token: string
    }
    assert.match(row.access_token, /^v1:/)
    assert.equal(row.access_token.includes(ACCESS), false)
    db.close()
  })

  test('绑定创作者会话、读取消息并记录出站方向', async () => {
    await connect()
    const linked = await app.inject({
      method: 'POST', url: '/api/snapchat/creators/connect', headers: auth,
      payload: { accountId: 'snap-main', creatorProfileIds: [CREATOR] }
    })
    assert.equal(linked.statusCode, 200)
    assert.equal(linked.json().connected, 1)
    const first = linked.json().conversations[0]
    assert.equal(first.title, 'Creator Alice')
    assert.equal(first.publicId, '@alice_snap')
    assert.equal(first.contactId, `snapchat:${BRAND}:${CREATOR}`)
    assert.equal(first.messages[0]._direction, 'in')
    assert.equal(first.messages[0]._text, 'hello snap')
    const sent = await app.inject({
      method: 'POST', url: '/api/snapchat/send', headers: auth,
      payload: { accountId: 'snap-main', conversationId: 'conversation-1', text: 'reply' }
    })
    assert.deepEqual(sent.json(), { messageId: 'sent-snap-1' })
    const db = new BetterSqlite3(dbPath)
    const token = (db.prepare('SELECT conversation_token FROM snapchat_conversations').get() as {
      conversation_token: string
    }).conversation_token
    const outbound = db.prepare('SELECT message_id FROM snapchat_sent_messages').get() as {
      message_id: string
    }
    assert.match(token, /^v1:/)
    assert.equal(token.includes('CONVERSATION_TOKEN'), false)
    assert.equal(outbound.message_id, 'sent-snap-1')
    db.close()
    const body = JSON.parse(calls.find((call) => call.method === 'POST' && call.url.includes('group_conversation_messages'))?.body || '{}')
    assert.equal(body.group_conversation_messages[0].text_message, 'reply')
  })
})
