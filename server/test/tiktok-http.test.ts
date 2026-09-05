import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'tiktok-test-token'
const OTHER_TOKEN = 'tiktok-other-tenant'
const APP_SECRET = 'tiktok-app-secret-32-characters-minimum'
const CIPHER_KEY = 'tiktok-token-encryption-key-32-characters-minimum'
const ACCESS_TOKEN = 'TIKTOK_ACCESS_TOKEN_MUST_STAY_SERVER_SIDE'
const REFRESH_TOKEN = 'TIKTOK_REFRESH_TOKEN_MUST_STAY_SERVER_SIDE'
const BUSINESS_ID = 'business-open-id-1'

interface FetchCall {
  url: string
  method: string
  accessToken?: string
  xUser?: string
  body?: string
}

describe('TikTok Business Messaging HTTP integration', () => {
  let dir: string
  let dbPath: string
  let app: FastifyInstance
  let calls: FetchCall[]

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
  const ok = (data: unknown): Response => json({ code: 0, message: 'OK', request_id: 'request-1', data })

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init.headers)
    calls.push({
      url,
      method: init.method || 'GET',
      accessToken: headers.get('access-token') || undefined,
      xUser: headers.get('x-user') || undefined,
      body: typeof init.body === 'string' ? init.body : undefined
    })
    const parsed = new URL(url)

    if (parsed.hostname === 'v16.tiktokcdn.com') {
      assert.equal(headers.get('x-user'), ACCESS_TOKEN)
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg' }
      })
    }
    if (parsed.pathname.endsWith('/tt_user/oauth2/token/')) {
      return ok({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 86_400,
        refresh_token_expires_in: 31_536_000,
        open_id: BUSINESS_ID,
        scope: 'message.list.read,message.list.send,user.info.basic'
      })
    }
    if (parsed.pathname.endsWith('/tt_user/oauth2/refresh_token/')) {
      return ok({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 86_400,
        refresh_token_expires_in: 31_536_000,
        open_id: BUSINESS_ID
      })
    }
    if (parsed.pathname.endsWith('/business/get/')) {
      assert.equal(headers.get('access-token'), ACCESS_TOKEN)
      return ok({
        username: 'omnichat_shop',
        display_name: 'WzzScrm Shop',
        profile_image: 'https://p16.tiktokcdn.com/shop.jpg',
        is_business_account: true
      })
    }
    if (parsed.pathname.endsWith('/business/webhook/update/')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      assert.equal(body.secret, APP_SECRET)
      assert.equal(body.event_type, 'DIRECT_MESSAGE')
      assert.equal(body.callback_url, 'https://wzzapp.cloud/webhook/tiktok')
      return ok({ event_type: 'DIRECT_MESSAGE' })
    }
    if (parsed.pathname.endsWith('/business/message/conversation/list/')) {
      assert.equal(headers.get('access-token'), ACCESS_TOKEN)
      return parsed.searchParams.get('conversation_type') === 'STRANGER'
        ? ok({ conversations: [{ conversation_id: 'conv+1==', update_time: 1_700_000_000_000 }], has_more: false, cursor: 1 })
        : ok({ conversations: [], has_more: false, cursor: 0 })
    }
    if (parsed.pathname.endsWith('/business/message/content/list/')) {
      assert.equal(parsed.searchParams.get('conversation_id'), 'conv+1==')
      return ok({
        participants: [
          { role: 'BUSINESS_ACCOUNT', id: BUSINESS_ID, display_name: 'WzzScrm Shop' },
          { role: 'PERSONAL_ACCOUNT', id: 'person-1', display_name: 'Alice', profile_image: 'https://p16.tiktokcdn.com/alice.jpg' }
        ],
        messages: [{
          message_id: 'history-1',
          conversation_id: 'conv+1==',
          sender: 'alice_tiktok',
          recipient: 'omnichat_shop',
          timestamp: 1_700_000_000_000,
          message_type: 'TEXT',
          from_user: { role: 'PERSONAL_ACCOUNT', id: 'person-1' },
          to_user: { role: 'BUSINESS_ACCOUNT', id: BUSINESS_ID },
          text: { body: 'hello before' }
        }]
      })
    }
    if (parsed.pathname.endsWith('/business/message/media/upload/')) {
      assert.ok(init.body instanceof FormData)
      return ok({ media_id: 'uploaded-media-1' })
    }
    if (parsed.pathname.endsWith('/business/message/media/download/')) {
      return ok({ download_url: 'https://v16.tiktokcdn.com/inbound.jpg' })
    }
    if (parsed.pathname.endsWith('/business/message/send/')) {
      assert.equal(headers.get('access-token'), ACCESS_TOKEN)
      return ok({ message: { message_id: 'sent-message-1' } })
    }
    return json({ code: 50000, message: `unexpected fake request: ${url}` }, 500)
  }

  function config(path: string): ServerConfig {
    return {
      port: 0,
      host: '127.0.0.1',
      dbPath: path,
      mediaDir: join(dir, 'media'),
      tokens: [TOKEN, OTHER_TOKEN],
      anthropicApiKey: undefined,
      analysisModel: 'claude-opus-5',
      adminUser: 'admin',
      adminPassword: 'admin',
      adminTenant: TOKEN,
      requireEmailVerify: false,
      clientTenant: TOKEN,
      smtp: undefined,
      publicUrl: 'https://wzzapp.cloud',
      updatesDir: join(dir, 'updates'),
      crispWebsiteId: undefined,
      tiktokAppId: 'tiktok-app-id',
      tiktokAppSecret: APP_SECRET,
      tiktokTokenEncryptionKey: CIPHER_KEY
    }
  }

  const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` })

  const connect = async (accountId = 'tt-main') => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/tiktok/oauth/start',
      headers: auth(),
      payload: { accountId }
    })
    assert.equal(started.statusCode, 200)
    const url = new URL(started.json().url)
    const state = url.searchParams.get('state')!
    const callback = await app.inject({
      method: 'GET',
      url: `/oauth/tiktok/callback?state=${encodeURIComponent(state)}&auth_code=auth-code`
    })
    assert.equal(callback.statusCode, 200)
    assert.match(callback.body, /TikTok 授权完成/)
    return { url, state, callback }
  }

  before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-tiktok-')) })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    calls = []
    dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`)
    app = buildServer(config(dbPath), { tiktokFetch: fakeFetch })
    await app.ready()
  })

  test('客户网页登录企业号后，服务器加密保存两种令牌且客户端响应不泄露', async () => {
    const { url, callback } = await connect()
    assert.equal(url.hostname, 'ads.tiktok.com')
    assert.equal(url.searchParams.get('app_id'), 'tiktok-app-id')
    assert.equal(url.searchParams.get('redirect_uri'), 'https://wzzapp.cloud/oauth/tiktok/callback')
    const scopes = new Set(url.searchParams.get('scope')?.split(','))
    assert.ok(scopes.has('message.list.read'))
    assert.ok(scopes.has('message.list.send'))
    assert.equal(callback.body.includes(ACCESS_TOKEN), false)
    assert.equal(callback.body.includes(REFRESH_TOKEN), false)

    const status = await app.inject({ method: 'GET', url: '/api/tiktok/account?accountId=tt-main', headers: auth() })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json().account, {
      channel: 'tiktok',
      accountId: 'tt-main',
      businessId: BUSINESS_ID,
      displayName: 'WzzScrm Shop',
      handle: 'omnichat_shop',
      avatarUrl: 'https://p16.tiktokcdn.com/shop.jpg'
    })
    assert.equal(status.body.includes(ACCESS_TOKEN), false)
    assert.equal(status.body.includes(REFRESH_TOKEN), false)

    const sqlite = new BetterSqlite3(dbPath, { readonly: true })
    const stored = sqlite.prepare(
      'SELECT access_token, refresh_token FROM tiktok_accounts WHERE account_id = ?'
    ).get('tt-main') as { access_token: string; refresh_token: string }
    sqlite.close()
    assert.match(stored.access_token, /^v1:/)
    assert.match(stored.refresh_token, /^v1:/)
    assert.equal(stored.access_token.includes(ACCESS_TOKEN), false)
    assert.equal(stored.refresh_token.includes(REFRESH_TOKEN), false)
  })

  test('Webhook 严格验证时间戳签名，按企业号入队并一次性拉取', async () => {
    await connect()
    const payload = JSON.stringify({
      client_key: 'tiktok-app-id',
      event: 'im_receive_msg',
      create_time: Math.floor(Date.now() / 1000),
      user_openid: BUSINESS_ID,
      content: JSON.stringify({
        from: 'alice_tiktok',
        to: 'omnichat_shop',
        unique_identifier: 'person-1',
        from_user: { role: 'personal_account', id: 'person-1' },
        to_user: { role: 'business_account', id: BUSINESS_ID },
        conversation_id: 'conv+1==',
        message_id: 'incoming-1',
        timestamp: Date.now(),
        type: 'text',
        text: { body: 'hello live' }
      })
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', APP_SECRET).update(`${timestamp}.${payload}`).digest('hex')
    const accepted = await app.inject({
      method: 'POST',
      url: '/webhook/tiktok',
      headers: { 'content-type': 'application/json', 'tiktok-signature': `t=${timestamp},s=${signature}` },
      payload
    })
    assert.equal(accepted.statusCode, 200)
    assert.equal(accepted.json().queued, 1)

    const pulled = await app.inject({ method: 'GET', url: '/api/tiktok/events?accountId=tt-main', headers: auth() })
    assert.equal(pulled.statusCode, 200)
    assert.equal(pulled.json().events[0].content.message_id, 'incoming-1')
    const again = await app.inject({ method: 'GET', url: '/api/tiktok/events?accountId=tt-main', headers: auth() })
    assert.deepEqual(again.json().events, [])

    const rejected = await app.inject({
      method: 'POST',
      url: '/webhook/tiktok',
      headers: { 'content-type': 'application/json', 'tiktok-signature': `t=${timestamp},s=${'0'.repeat(64)}` },
      payload
    })
    assert.equal(rejected.statusCode, 401)
  })

  test('历史资料、文本/图片发送和入站媒体下载均由服务器代调', async () => {
    await connect()
    const history = await app.inject({ method: 'GET', url: '/api/tiktok/history?accountId=tt-main', headers: auth() })
    assert.equal(history.statusCode, 200)
    assert.deepEqual(history.json().conversations[0], {
      externalChatId: 'conv+1==',
      title: 'Alice',
      publicId: '@alice_tiktok',
      contactId: `tiktok:${BUSINESS_ID}:person-1`,
      avatarUrl: 'https://p16.tiktokcdn.com/alice.jpg',
      updatedTime: 1_700_000_000_000,
      messages: [{
        message_id: 'history-1', conversation_id: 'conv+1==', sender: 'alice_tiktok',
        recipient: 'omnichat_shop', timestamp: 1_700_000_000_000, message_type: 'TEXT',
        from_user: { role: 'PERSONAL_ACCOUNT', id: 'person-1' },
        to_user: { role: 'BUSINESS_ACCOUNT', id: BUSINESS_ID }, text: { body: 'hello before' }
      }]
    })

    const sent = await app.inject({
      method: 'POST', url: '/api/tiktok/send', headers: auth(),
      payload: { accountId: 'tt-main', conversationId: 'conv+1==', text: 'reply' }
    })
    assert.equal(sent.statusCode, 200)
    assert.equal(sent.json().messageId, 'sent-message-1')

    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
    const sentImage = await app.inject({
      method: 'POST', url: '/api/tiktok/send-media', headers: auth(),
      payload: {
        accountId: 'tt-main', conversationId: 'conv+1==', mediaType: 'image',
        mimeType: 'image/jpeg', dataBase64: image.toString('base64')
      }
    })
    assert.equal(sentImage.statusCode, 200)
    assert.equal(sentImage.json().messageId, 'sent-message-1')

    const downloaded = await app.inject({
      method: 'GET',
      url: '/api/tiktok/media?accountId=tt-main&conversationId=conv%2B1%3D%3D&messageId=in-1&mediaId=media-1&mediaType=IMAGE',
      headers: auth()
    })
    assert.equal(downloaded.statusCode, 200)
    assert.equal(downloaded.headers['content-type'], 'image/jpeg')
    assert.equal(downloaded.rawPayload.length, 7)
    assert.equal(JSON.stringify({ history: history.json(), sent: sent.json() }).includes(ACCESS_TOKEN), false)
    assert.ok(calls.some((call) => call.xUser === ACCESS_TOKEN))
  })

  test('账号严格按租户隔离', async () => {
    await connect()
    const other = await app.inject({
      method: 'GET', url: '/api/tiktok/account?accountId=tt-main', headers: auth(OTHER_TOKEN)
    })
    assert.equal(other.statusCode, 200)
    assert.equal(other.json().status, 'disconnected')
    assert.equal(other.body.includes(ACCESS_TOKEN), false)
  })
})
