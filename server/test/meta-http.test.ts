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

const TOKEN = 'meta-test-token'
const OTHER_TOKEN = 'meta-other-tenant'
const FB_SECRET = 'facebook-app-secret-32-characters-minimum'
const IG_SECRET = 'instagram-app-secret-32-characters-minimum'
const CIPHER_KEY = 'meta-token-encryption-key-32-characters-minimum'
const VERIFY_TOKEN = 'meta-webhook-verify-token'
const PAGE_TOKEN = 'PAGE_ACCESS_TOKEN_MUST_STAY_SERVER_SIDE'
const IG_TOKEN = 'IG_LONG_TOKEN_MUST_STAY_SERVER_SIDE'

interface FetchCall {
  url: string
  method: string
  authorization?: string
  body?: string
}

describe('Meta Messenger / Instagram HTTP integration', () => {
  let dir: string
  let dbPath: string
  let app: FastifyInstance
  let calls: FetchCall[]

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init.headers)
    calls.push({
      url,
      method: init.method || 'GET',
      authorization: headers.get('authorization') || undefined,
      body: typeof init.body === 'string' ? init.body : undefined
    })
    const parsed = new URL(url)

    if (parsed.hostname === 'api.instagram.com' && parsed.pathname === '/oauth/access_token') {
      return json({ access_token: 'IG_SHORT_TOKEN', user_id: 'ig-1' })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/access_token') {
      return json({ access_token: IG_TOKEN, token_type: 'bearer', expires_in: 5_000_000 })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/me') {
      return json({ id: 'ig-1', user_id: 'ig-1', username: 'omni_shop', name: 'Omni Shop' })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/ig-1/subscribed_apps') {
      return json({ success: true })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/ig-1/messages') {
      return json({ message_id: 'ig-message-1', recipient_id: 'igsid-1' })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/igsid-1') {
      return json({ id: 'igsid-1', name: 'IG Customer', username: 'ig_customer' })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/ig-1/conversations') {
      return json({ data: [] })
    }

    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/oauth/access_token') {
      return json({ access_token: parsed.searchParams.has('grant_type') ? 'FB_LONG_USER_TOKEN' : 'FB_SHORT_USER_TOKEN' })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/me/accounts') {
      assert.equal(headers.get('authorization'), 'Bearer FB_LONG_USER_TOKEN')
      return json({
        data: [{
          id: 'page-1',
          name: 'Support Page',
          username: 'support.page',
          access_token: PAGE_TOKEN,
          tasks: ['MESSAGING'],
          picture: { data: { url: 'https://lookaside.fbsbx.com/page.jpg' } }
        }]
      })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/page-1/subscribed_apps') {
      assert.equal(headers.get('authorization'), `Bearer ${PAGE_TOKEN}`)
      return json({ success: true })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/page-1/messages') {
      assert.equal(headers.get('authorization'), `Bearer ${PAGE_TOKEN}`)
      return json({ message_id: 'fb-message-1', recipient_id: 'psid-1' })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/psid-1') {
      return json({ id: 'psid-1', name: 'FB Customer', profile_pic: 'https://lookaside.fbsbx.com/customer.jpg' })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/page-1/conversations') {
      return json({ data: [] })
    }
    return json({ error: { message: `unexpected fake request: ${url}` } }, 500)
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
      metaAppId: 'facebook-app-id',
      metaAppSecret: FB_SECRET,
      metaInstagramAppId: 'instagram-app-id',
      metaInstagramAppSecret: IG_SECRET,
      metaWebhookVerifyToken: VERIFY_TOKEN,
      metaTokenEncryptionKey: CIPHER_KEY,
      metaGraphVersion: 'v26.0'
    }
  }

  const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` })
  const begin = async (channel: 'facebook' | 'instagram', accountId: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/meta/oauth/start',
      headers: auth(),
      payload: { channel, accountId }
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { url: string }
    return { url: new URL(body.url), state: new URL(body.url).searchParams.get('state')! }
  }

  const connectFacebook = async (accountId = 'fb-main') => {
    const { state } = await begin('facebook', accountId)
    const callback = await app.inject({
      method: 'GET',
      url: `/oauth/meta/callback?state=${encodeURIComponent(state)}&code=fb-code`
    })
    assert.equal(callback.statusCode, 200)
    assert.match(callback.body, /授权完成/)
    return callback
  }

  before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-meta-')) })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    calls = []
    dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`)
    app = buildServer(config(dbPath), { metaFetch: fakeFetch })
    await app.ready()
  })

  test('Facebook OAuth 只要求客户网页登录，连接后客户端永远拿不到令牌', async () => {
    const started = await begin('facebook', 'fb-main')
    assert.equal(started.url.hostname, 'www.facebook.com')
    assert.equal(started.url.searchParams.get('redirect_uri'), 'https://wzzapp.cloud/oauth/meta/callback')
    const scopes = new Set(started.url.searchParams.get('scope')?.split(','))
    for (const permission of ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement']) {
      assert.ok(scopes.has(permission), `缺少 ${permission}`)
    }

    const callback = await app.inject({
      method: 'GET',
      url: `/oauth/meta/callback?state=${encodeURIComponent(started.state)}&code=fb-code`
    })
    assert.equal(callback.statusCode, 200)
    assert.match(callback.body, /授权完成/)
    assert.equal(callback.body.includes(PAGE_TOKEN), false)

    const status = await app.inject({ method: 'GET', url: '/api/meta/account?channel=facebook&accountId=fb-main', headers: auth() })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json().account, {
      channel: 'facebook',
      accountId: 'fb-main',
      assetId: 'page-1',
      pageId: 'page-1',
      displayName: 'Support Page',
      handle: 'support.page',
      avatarUrl: 'https://lookaside.fbsbx.com/page.jpg'
    })
    assert.equal(status.body.includes(PAGE_TOKEN), false)

    const listed = await app.inject({ method: 'GET', url: '/api/meta/accounts', headers: auth() })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().accounts.length, 1)
    assert.equal(listed.json().accounts[0].displayName, 'Support Page')
    assert.equal(listed.body.includes(PAGE_TOKEN), false)

    const sqlite = new BetterSqlite3(dbPath, { readonly: true })
    const stored = sqlite.prepare('SELECT access_token FROM meta_accounts WHERE account_id = ?').get('fb-main') as { access_token: string }
    sqlite.close()
    assert.match(stored.access_token, /^v1:/)
    assert.equal(stored.access_token.includes(PAGE_TOKEN), false)
  })

  test('Instagram 使用独立 Instagram Login，专业账号授权后自动订阅消息', async () => {
    const started = await begin('instagram', 'ig-main')
    assert.equal(started.url.hostname, 'www.instagram.com')
    assert.equal(started.url.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages')

    const callback = await app.inject({
      method: 'GET',
      url: `/oauth/meta/callback?state=${encodeURIComponent(started.state)}&code=ig-code`
    })
    assert.equal(callback.statusCode, 200)
    assert.match(callback.body, /授权完成/)
    assert.equal(callback.body.includes(IG_TOKEN), false)

    const status = await app.inject({ method: 'GET', url: '/api/meta/account?channel=instagram&accountId=ig-main', headers: auth() })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json().account, {
      channel: 'instagram',
      accountId: 'ig-main',
      assetId: 'ig-1',
      pageId: 'ig-1',
      displayName: 'Omni Shop',
      handle: 'omni_shop'
    })
    assert.ok(calls.some((call) => call.url.includes('/ig-1/subscribed_apps') && call.authorization === `Bearer ${IG_TOKEN}`))
  })

  test('Webhook challenge 与 SHA-256 原始正文签名均被严格验证', async () => {
    await connectFacebook()
    const challenge = await app.inject({
      method: 'GET',
      url: `/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=123456`
    })
    assert.equal(challenge.statusCode, 200)
    assert.equal(challenge.body, '123456')

    const payload = JSON.stringify({
      object: 'page',
      entry: [{
        id: 'page-1',
        messaging: [{
          sender: { id: 'psid-1' },
          recipient: { id: 'page-1' },
          timestamp: 1_700_000_000_000,
          message: { mid: 'incoming-1', text: 'hello' }
        }]
      }]
    })
    const signature = `sha256=${createHmac('sha256', FB_SECRET).update(payload).digest('hex')}`
    const accepted = await app.inject({
      method: 'POST',
      url: '/webhook/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload
    })
    assert.equal(accepted.statusCode, 200)
    assert.equal(accepted.json().queued, 1)

    const pulled = await app.inject({ method: 'GET', url: '/api/meta/events?channel=facebook&accountId=fb-main', headers: auth() })
    assert.equal(pulled.statusCode, 200)
    assert.equal(pulled.json().events[0].event.message.mid, 'incoming-1')
    const pulledAgain = await app.inject({ method: 'GET', url: '/api/meta/events?channel=facebook&accountId=fb-main', headers: auth() })
    assert.deepEqual(pulledAgain.json().events, [])

    const rejected = await app.inject({
      method: 'POST',
      url: '/webhook/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      payload
    })
    assert.equal(rejected.statusCode, 401)
  })

  test('发消息和查资料均由服务器代调 Graph，客户端响应不暴露 Page Token', async () => {
    await connectFacebook()
    const sent = await app.inject({
      method: 'POST',
      url: '/api/meta/send',
      headers: auth(),
      payload: { channel: 'facebook', accountId: 'fb-main', recipientId: 'psid-1', text: 'reply' }
    })
    assert.equal(sent.statusCode, 200)
    assert.deepEqual(sent.json(), { messageId: 'fb-message-1', recipientId: 'psid-1' })
    assert.equal(sent.body.includes(PAGE_TOKEN), false)

    const profile = await app.inject({
      method: 'GET',
      url: '/api/meta/profile?channel=facebook&accountId=fb-main&userId=psid-1',
      headers: auth()
    })
    assert.equal(profile.statusCode, 200)
    assert.equal(profile.json().profile.name, 'FB Customer')
    assert.equal(profile.body.includes(PAGE_TOKEN), false)

    const mediaBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    const media = await app.inject({
      method: 'POST',
      url: '/api/meta/send-media',
      headers: auth(),
      payload: {
        channel: 'facebook',
        accountId: 'fb-main',
        recipientId: 'psid-1',
        mediaType: 'image',
        mimeType: 'image/jpeg',
        dataBase64: mediaBytes.toString('base64')
      }
    })
    assert.equal(media.statusCode, 200)
    assert.equal(media.body.includes(mediaBytes.toString('base64')), false)
    assert.equal(media.body.includes(PAGE_TOKEN), false)

    const graphMedia = calls.find((call) =>
      call.url.includes('/page-1/messages') && call.body?.includes('attachment')
    )
    assert.ok(graphMedia?.body)
    const graphBody = JSON.parse(graphMedia.body) as {
      message: { attachment: { payload: { url: string } } }
    }
    const stagedUrl = new URL(graphBody.message.attachment.payload.url)
    assert.equal(stagedUrl.hostname, 'wzzapp.cloud')
    const served = await app.inject({ method: 'GET', url: `${stagedUrl.pathname}${stagedUrl.search}` })
    assert.equal(served.statusCode, 200)
    assert.equal(served.headers['content-type'], 'image/jpeg')
    assert.deepEqual(served.rawPayload, mediaBytes)

    stagedUrl.searchParams.set('signature', 'tampered')
    const rejected = await app.inject({ method: 'GET', url: `${stagedUrl.pathname}${stagedUrl.search}` })
    assert.equal(rejected.statusCode, 404)
  })

  test('团队授权按租户隔离，另一个同步令牌不能读取账号', async () => {
    await connectFacebook()
    const other = await app.inject({
      method: 'GET',
      url: '/api/meta/account?channel=facebook&accountId=fb-main',
      headers: auth(OTHER_TOKEN)
    })
    assert.equal(other.statusCode, 200)
    assert.equal(other.json().status, 'disconnected')
    assert.equal(other.body.includes(PAGE_TOKEN), false)
  })
})
