import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'sync-pull-test'
let dir: string
let app: FastifyInstance

function config(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    updatesDir: join(dir, 'updates'),
    tokens: [TOKEN],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TOKEN,
    clientTenant: TOKEN,
    requireEmailVerify: false,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    crispWebsiteId: undefined
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omni-sync-pull-'))
  app = buildServer(config(join(dir, 'data.db')))
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('同步客户端服务端回填', () => {
  test('静态同步令牌可按复合游标读取本租户消息与会话', async () => {
    const headers = { authorization: `Bearer ${TOKEN}` }
    const pushed = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers,
      payload: {
        conversations: [{
          id: 'whatsapp:main:u1', channel: 'whatsapp', accountId: 'main',
          title: '客户', isGroup: false, lastMessageAt: 1000
        }],
        messages: [{
          externalId: 'REMOTE-1', conversationId: 'whatsapp:main:u1', channel: 'whatsapp', accountId: 'main',
          direction: 'in', bodyType: 'text', text: '历史消息', timestamp: 1000
        }]
      }
    })
    assert.equal(pushed.statusCode, 200)

    const pulled = await app.inject({ method: 'GET', url: '/api/sync/pull?after=0&afterId=&limit=1', headers })
    assert.equal(pulled.statusCode, 200)
    const body = pulled.json() as { messages: Array<{ externalId: string; syncUpdatedAt: number }>; conversations: Array<{ id: string }>; cursor: { externalId: string } }
    assert.equal(body.messages[0]?.externalId, 'REMOTE-1')
    assert.ok(body.messages[0]!.syncUpdatedAt > 0)
    assert.deepEqual(body.conversations.map((c) => c.id), ['whatsapp:main:u1'])
    assert.equal(body.cursor.externalId, 'REMOTE-1')

    const after = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?after=${body.cursor ? body.messages[0]!.syncUpdatedAt : 0}&afterId=REMOTE-1`,
      headers
    })
    assert.deepEqual((after.json() as { messages: unknown[] }).messages, [])
  })

  test('邮箱登录客户端无需管理后台权限即可同步并读取聊天', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/client/register',
      payload: { email: 'chat@test.com', password: 'password123' }
    })
    assert.equal(registered.statusCode, 200)
    const token = (registered.json() as { token: string }).token
    const headers = { authorization: `Bearer ${token}` }

    const pushed = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers,
      payload: {
        conversations: [{
          id: 'line:main:u1', channel: 'line', accountId: 'main',
          title: '客户', isGroup: false, lastMessageAt: 1000
        }],
        messages: [{
          externalId: 'CLIENT-1', conversationId: 'line:main:u1', channel: 'line', accountId: 'main',
          direction: 'in', bodyType: 'text', text: '客户消息', timestamp: 1000
        }]
      }
    })
    assert.equal(pushed.statusCode, 200)

    const conversations = await app.inject({ method: 'GET', url: '/api/conversations', headers })
    assert.equal(conversations.statusCode, 200)
    assert.deepEqual(
      (conversations.json() as { conversations: Array<{ id: string }> }).conversations.map((c) => c.id),
      ['line:main:u1']
    )

    const pulled = await app.inject({ method: 'GET', url: '/api/sync/pull?after=0', headers })
    assert.equal(pulled.statusCode, 200)
    assert.deepEqual(
      (pulled.json() as { messages: Array<{ externalId: string }> }).messages.map((m) => m.externalId),
      ['CLIENT-1']
    )
  })

  test('两个独立老板即使共用 clientTenant 也看不到彼此聊天；同一账号换电脑可恢复', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/client/register',
      payload: { email: 'owner-a@test.com', password: 'password123' }
    })
    const second = await app.inject({
      method: 'POST', url: '/api/client/register',
      payload: { email: 'owner-b@test.com', password: 'password123' }
    })
    const firstToken = (first.json() as { token: string }).token
    const secondToken = (second.json() as { token: string }).token
    const firstHeaders = { authorization: `Bearer ${firstToken}` }

    await app.inject({
      method: 'POST', url: '/api/sync', headers: firstHeaders,
      payload: {
        conversations: [{
          id: 'telegram:a:42', channel: 'telegram', accountId: 'a', title: 'A 的客户',
          isGroup: false, pinned: true, customerNote: '仅 A 可见', lastMessageAt: 1000
        }],
        messages: [{
          externalId: 'A-M1', conversationId: 'telegram:a:42', channel: 'telegram', accountId: 'a',
          direction: 'in', bodyType: 'text', text: 'secret', timestamp: 1000
        }]
      }
    })

    const isolated = await app.inject({
      method: 'GET', url: '/api/sync/pull?after=0',
      headers: { authorization: `Bearer ${secondToken}` }
    })
    assert.deepEqual((isolated.json() as { messages: unknown[] }).messages, [])

    const loginAgain = await app.inject({
      method: 'POST', url: '/api/client/login',
      payload: { email: 'owner-a@test.com', password: 'password123' }
    })
    const anotherDeviceHeaders = {
      authorization: `Bearer ${(loginAgain.json() as { token: string }).token}`
    }
    const restored = await app.inject({ method: 'GET', url: '/api/sync/pull?after=0', headers: anotherDeviceHeaders })
    assert.deepEqual(
      (restored.json() as { messages: Array<{ externalId: string }> }).messages.map((m) => m.externalId),
      ['A-M1']
    )
    const convs = await app.inject({ method: 'GET', url: '/api/sync/conversations?after=0', headers: anotherDeviceHeaders })
    const restoredConversation = (convs.json() as {
      conversations: Array<{ title: string; pinned: boolean; customerNote: string }>
    }).conversations[0]
    assert.equal(restoredConversation?.title, 'A 的客户')
    assert.equal(restoredConversation?.pinned, true)
    assert.equal(restoredConversation?.customerNote, '仅 A 可见')
  })

  test('账号目录只漫游安全摘要，删除墓碑、已读和 AI 抢占可跨两台电脑同步', async () => {
    const registered = await app.inject({
      method: 'POST', url: '/api/client/register',
      payload: { email: 'multi-device@test.com', password: 'password123' }
    })
    const token1 = (registered.json() as { token: string }).token
    const login2 = await app.inject({
      method: 'POST', url: '/api/client/login',
      payload: { email: 'multi-device@test.com', password: 'password123' }
    })
    const h1 = { authorization: `Bearer ${token1}` }
    const h2 = { authorization: `Bearer ${(login2.json() as { token: string }).token}` }

    const saved = await app.inject({
      method: 'PUT', url: '/api/client/accounts/whatsapp%3Awa123', headers: h1,
      payload: {
        accountKey: 'whatsapp:wa123', channel: 'whatsapp', accountId: 'wa123',
        label: '销售号', defaultLang: 'en', proxyUrl: 'socks5://secret', credentials: { session: 'secret' }
      }
    })
    assert.equal(saved.statusCode, 200)
    const catalog = await app.inject({ method: 'GET', url: '/api/client/accounts', headers: h2 })
    const dumped = JSON.stringify(catalog.json())
    assert.match(dumped, /销售号/)
    assert.doesNotMatch(dumped, /socks5|session|secret/)

    await app.inject({ method: 'DELETE', url: '/api/client/accounts/whatsapp%3Awa123', headers: h1 })
    const deleted = (await app.inject({ method: 'GET', url: '/api/client/accounts', headers: h2 })).json() as {
      accounts: Array<{ accountKey: string; deleted: boolean }>
    }
    assert.equal(deleted.accounts.find((a) => a.accountKey === 'whatsapp:wa123')?.deleted, true)

    await app.inject({ method: 'PUT', url: '/api/conversations/telegram%3Aa%3A42/read', headers: h1, payload: {} })
    const reads = (await app.inject({ method: 'GET', url: '/api/sync/reads?after=0', headers: h2 })).json() as {
      reads: Array<{ conversationId: string }>
    }
    assert.deepEqual(reads.reads.map((r) => r.conversationId), ['telegram:a:42'])

    const claim1 = await app.inject({
      method: 'POST', url: '/api/sync/claim', headers: h1,
      payload: { purpose: 'auto-reply', key: 'telegram:a:42:M1' }
    })
    const claim2 = await app.inject({
      method: 'POST', url: '/api/sync/claim', headers: h2,
      payload: { purpose: 'auto-reply', key: 'telegram:a:42:M1' }
    })
    assert.equal((claim1.json() as { claimed: boolean }).claimed, true)
    assert.equal((claim2.json() as { claimed: boolean }).claimed, false)
  })

  test('免费用户端口上限由服务器强制执行，更新和删除后重建不误拦截', async () => {
    const registered = await app.inject({
      method: 'POST', url: '/api/client/register',
      payload: { email: 'quota@test.com', password: 'password123' }
    })
    const headers = { authorization: `Bearer ${(registered.json() as { token: string }).token}` }
    for (let index = 1; index <= 10; index += 1) {
      const saved = await app.inject({
        method: 'PUT', url: `/api/client/accounts/telegram%3Aaccount-${index}`, headers,
        payload: { channel: 'telegram', accountId: `account-${index}`, label: `账号 ${index}` }
      })
      assert.equal(saved.statusCode, 200, saved.body)
    }

    const blocked = await app.inject({
      method: 'PUT', url: '/api/client/accounts/telegram%3Aaccount-11', headers,
      payload: { channel: 'telegram', accountId: 'account-11' }
    })
    assert.equal(blocked.statusCode, 409)
    assert.equal((blocked.json() as { code: string }).code, 'account_quota_reached')

    const update = await app.inject({
      method: 'PUT', url: '/api/client/accounts/telegram%3Aaccount-1', headers,
      payload: { channel: 'telegram', accountId: 'account-1', label: '更新后的账号' }
    })
    assert.equal(update.statusCode, 200, update.body)

    await app.inject({
      method: 'DELETE', url: '/api/client/accounts/telegram%3Aaccount-2', headers
    })
    const replacement = await app.inject({
      method: 'PUT', url: '/api/client/accounts/telegram%3Aaccount-11', headers,
      payload: { channel: 'telegram', accountId: 'account-11' }
    })
    assert.equal(replacement.statusCode, 200, replacement.body)
  })
})
