import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TENANT = 'admin-workspace-test'
let dir = ''
let app: FastifyInstance

function config(): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: join(dir, 'data.db'),
    mediaDir: join(dir, 'media'),
    updatesDir: join(dir, 'updates'),
    tokens: [TENANT],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TENANT,
    clientTenant: TENANT,
    requireEmailVerify: false,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    crispWebsiteId: undefined
  }
}

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/client/register',
    payload: { email, password: 'password123' }
  })
  assert.equal(response.statusCode, 200)
  return (response.json() as { token: string }).token
}

async function adminToken(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'admin' }
  })
  assert.equal(response.statusCode, 200)
  return (response.json() as { token: string }).token
}

async function push(token: string, id: string, title: string, text: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sync',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      conversations: [{
        id,
        channel: 'telegram',
        accountId: 'shared-account',
        contactId: 'tg:42',
        title,
        isGroup: false,
        lastMessageAt: Date.now()
      }],
      messages: [{
        externalId: `${title}-message`,
        conversationId: id,
        channel: 'telegram',
        accountId: 'shared-account',
        direction: 'in',
        bodyType: 'text',
        text,
        timestamp: Date.now()
      }]
    }
  })
  assert.equal(response.statusCode, 200)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wzzscrm-admin-workspace-'))
  app = buildServer(config())
  await app.ready()
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('管理端客户工作区可见性', () => {
  test('客户之间隔离，管理员汇总可见且相同会话 id 不串数据', async () => {
    const ownerA = await register('owner-a@example.com')
    const ownerB = await register('owner-b@example.com')
    const conversationId = 'telegram:shared-account:42'
    await push(ownerA, conversationId, 'A 的客户', 'A secret')
    await push(ownerB, conversationId, 'B 的客户', 'B secret')

    const aList = await app.inject({
      method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${ownerA}` }
    })
    assert.deepEqual(
      (aList.json() as { conversations: Array<{ title: string }> }).conversations.map((c) => c.title),
      ['A 的客户']
    )

    const admin = await adminToken()
    const headers = { authorization: `Bearer ${admin}` }
    const list = await app.inject({ method: 'GET', url: '/api/conversations', headers })
    const conversations = (list.json() as {
      conversations: Array<{ id: string; title: string; workspace: string }>
    }).conversations.filter((c) => c.id === conversationId)
    assert.equal(conversations.length, 2)
    assert.equal(new Set(conversations.map((c) => c.workspace)).size, 2)

    const ambiguous = await app.inject({
      method: 'GET', url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`, headers
    })
    assert.equal(ambiguous.statusCode, 409)

    for (const conversation of conversations) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/conversations/${encodeURIComponent(conversationId)}/messages?workspace=${encodeURIComponent(conversation.workspace)}`,
        headers
      })
      assert.equal(response.statusCode, 200)
      const text = (response.json() as { messages: Array<{ text: string }> }).messages[0]?.text
      assert.equal(text, conversation.title.startsWith('A') ? 'A secret' : 'B secret')
    }

    const outsideTenant = await app.inject({
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent(conversationId)}/messages?workspace=${encodeURIComponent('other::workspace:1')}`,
      headers
    })
    assert.equal(outsideTenant.statusCode, 403)
  })

  test('管理员可查看客户端创建的工单并读取精确工作区统计', async () => {
    const owner = await register('campaign-owner@example.com')
    const created = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: '客户工单', accountIds: ['a1'], startAt: Date.now() - 1_000 }
    })
    assert.equal(created.statusCode, 200)
    const campaignId = (created.json() as { campaign: { id: string } }).campaign.id

    const admin = await adminToken()
    const headers = { authorization: `Bearer ${admin}` }
    const list = await app.inject({ method: 'GET', url: '/api/campaigns', headers })
    const campaign = (list.json() as {
      campaigns: Array<{ id: string; name: string; workspace: string }>
    }).campaigns.find((item) => item.id === campaignId)
    assert.equal(campaign?.name, '客户工单')
    assert.ok(campaign?.workspace.startsWith(`${TENANT}::workspace:`))

    const stats = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${encodeURIComponent(campaignId)}/stats?workspace=${encodeURIComponent(campaign!.workspace)}`,
      headers
    })
    assert.equal(stats.statusCode, 200)
    assert.equal((stats.json() as { campaign: { id: string } }).campaign.id, campaignId)
  })
})
