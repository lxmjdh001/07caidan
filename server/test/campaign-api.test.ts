import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'dev-token'
const T0 = Date.UTC(2026, 7, 15, 16, 0, 0)

let dir: string
let app: FastifyInstance

function makeConfig(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    tokens: [TOKEN],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TOKEN,
    requireEmailVerify: false,
    clientTenant: TOKEN,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

/** 带同步客户端令牌的请求（老板在客户端里操作工单） */
async function api(
  method: string,
  url: string,
  body?: unknown,
  token: string | null = TOKEN
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try {
    json = res.json()
  } catch {
    json = { raw: res.body }
  }
  return { status: res.statusCode, json }
}

/** 灌一条进线记录 */
async function seed(
  accountId: string,
  contactId: string,
  at: number,
  replyAt?: number,
  sourceCode?: string
) {
  const convId = `whatsapp:${accountId}:${contactId}`
  const messages: unknown[] = [
    {
      externalId: `${convId}:in:${at}`,
      conversationId: convId,
      channel: 'whatsapp',
      accountId,
      direction: 'in',
      bodyType: 'text',
      text: '你好我想了解一下',
      timestamp: at
    }
  ]
  if (replyAt) {
    messages.push({
      externalId: `${convId}:out:${replyAt}`,
      conversationId: convId,
      channel: 'whatsapp',
      accountId,
      direction: 'out',
      bodyType: 'text',
      text: '您好',
      timestamp: replyAt
    })
  }
  await api('POST', '/api/sync', {
    conversations: [
      {
        id: convId,
        channel: 'whatsapp',
        accountId,
        contactId,
        title: '张三',
        isGroup: false,
        lastMessageAt: at,
        ...(sourceCode ? { leadSourceCode: sourceCode, leadSourceVia: 'code' } : {})
      }
    ],
    messages
  })
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-capi-'))
})
after(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

describe('工单接口', () => {
  test('未授权访问被拒', async () => {
    assert.equal((await api('GET', '/api/campaigns', undefined, null)).status, 401)
  })

  test('创建 → 列表 → 删除', async () => {
    const created = await api('POST', '/api/campaigns', {
      name: '八月推广',
      accountIds: ['a1'],
      accountLabels: { a1: '主号' },
      startAt: T0
    })
    assert.equal(created.status, 200)
    const id = created.json.campaign.id

    const list = await api('GET', '/api/campaigns')
    assert.equal(list.json.campaigns.length, 1)
    assert.equal(list.json.campaigns[0].accountLabels.a1, '主号')

    assert.equal((await api('DELETE', `/api/campaigns/${id}`)).status, 200)
    assert.equal((await api('GET', '/api/campaigns')).json.campaigns.length, 0)
  })

  test('参数校验：名称、账号、时间', async () => {
    assert.equal((await api('POST', '/api/campaigns', { accountIds: ['a1'], startAt: T0 })).status, 400)
    assert.equal((await api('POST', '/api/campaigns', { name: 'x', accountIds: [], startAt: T0 })).status, 400)
    assert.equal((await api('POST', '/api/campaigns', { name: 'x', accountIds: ['a1'] })).status, 400)
    const bad = await api('POST', '/api/campaigns', {
      name: 'x',
      accountIds: ['a1'],
      startAt: T0,
      endAt: T0 - 1000
    })
    assert.equal(bad.status, 400)
  })

  test('统计预览反映真实数据', async () => {
    await seed('a1', 'wa:+8613800138000', T0 + 3600_000, T0 + 3660_000)
    await seed('a1', 'wa:+8613900139000', T0 + 7200_000)
    const { json } = await api('POST', '/api/campaigns', {
      name: 'x',
      accountIds: ['a1'],
      startAt: T0
    })
    const stats = (await api('GET', `/api/campaigns/${json.campaign.id}/stats`)).json.stats
    assert.equal(stats.total, 2)
    assert.equal(stats.fresh, 2)
    assert.equal(stats.response.replied, 1)
  })
})

describe('工单编辑', () => {
  test('修改账号/时间/来源筛选后统计随之变化', async () => {
    await seed('a1', 'wa:+8613800138000', T0 + 3600_000, undefined, 'ad1')
    await seed('a1', 'wa:+8613900139000', T0 + 3600_000)
    await seed('a2', 'wa:+8615000150000', T0 + 3600_000)
    const c = (
      await api('POST', '/api/campaigns', { name: 'x', accountIds: ['a1'], startAt: T0 })
    ).json.campaign
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 2)

    // 添加账号 a2 → 统计多一条
    const r1 = await api('PATCH', `/api/campaigns/${c.id}`, { accountIds: ['a1', 'a2'] })
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.json.campaign.accountIds, ['a1', 'a2'])
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 3)

    // 移除 a1 只剩 a2
    await api('PATCH', `/api/campaigns/${c.id}`, { accountIds: ['a2'] })
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 1)

    // 改回 a1 并按来源码过滤 → 只剩 ad1 那条
    await api('PATCH', `/api/campaigns/${c.id}`, { accountIds: ['a1'], sourceCodes: ['ad1'] })
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 1)
    // 清空来源筛选恢复全量
    await api('PATCH', `/api/campaigns/${c.id}`, { sourceCodes: [] })
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 2)

    // 收窄时间窗到进线之前 → 0
    await api('PATCH', `/api/campaigns/${c.id}`, { endAt: T0 + 1000 })
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 0)
    // 清掉结束时间（显式 null）恢复
    await api('PATCH', `/api/campaigns/${c.id}`, { endAt: null })
    assert.equal((await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats.total, 2)
  })

  test('编辑校验：空账号、结束早于开始、跨字段时间联合校验', async () => {
    const c = (
      await api('POST', '/api/campaigns', { name: 'x', accountIds: ['a1'], startAt: T0 })
    ).json.campaign
    assert.equal((await api('PATCH', `/api/campaigns/${c.id}`, { accountIds: [] })).status, 400)
    assert.equal(
      (await api('PATCH', `/api/campaigns/${c.id}`, { endAt: T0 - 1 })).status,
      400
    )
    // 只改 startAt 把它推到已有 endAt 之后也要被拒
    await api('PATCH', `/api/campaigns/${c.id}`, { endAt: T0 + 1000 })
    assert.equal(
      (await api('PATCH', `/api/campaigns/${c.id}`, { startAt: T0 + 2000 })).status,
      400
    )
    assert.equal((await api('PATCH', '/api/campaigns/nonexistent', { name: 'y' })).status, 404)
  })
})

describe('分享链接与公开看板', () => {
  async function setup() {
    await seed('a1', 'wa:+8613800138000', T0 + 3600_000, T0 + 3660_000)
    const c = (
      await api('POST', '/api/campaigns', {
        name: '八月推广',
        accountIds: ['a1'],
        accountLabels: { a1: '主号' },
        startAt: T0
      })
    ).json.campaign
    const link = (await api('POST', `/api/campaigns/${c.id}/links`, { label: '给团队' })).json
    return { campaign: c, link: link.link, url: link.url }
  }

  test('创建的链接可公开访问，无需任何令牌', async () => {
    const { link, url } = await setup()
    assert.match(url, /\/c\/[0-9a-f]{32}$/)
    const pub = await api('GET', `/public/campaign/${link.token}`, undefined, null)
    assert.equal(pub.status, 200)
    assert.equal(pub.json.campaign.name, '八月推广')
    assert.equal(pub.json.stats.total, 1)
  })

  test('公开看板绝不返回聊天内容或粉丝身份', async () => {
    const { link } = await setup()
    const res = await app.inject({ method: 'GET', url: `/public/campaign/${link.token}` })
    const raw = res.body
    // 灌进去的手机号、昵称、聊天原文都不得出现在公开响应里
    assert.equal(raw.includes('8613800138000'), false)
    assert.equal(raw.includes('张三'), false)
    assert.equal(raw.includes('你好我想了解一下'), false)
    assert.equal(raw.includes('contactId'), false)
    assert.equal(raw.includes('wa:'), false)
  })

  test('撤销后立即不可访问', async () => {
    const { link } = await setup()
    await api('POST', `/api/campaigns/links/${link.token}/revoke`)
    const pub = await api('GET', `/public/campaign/${link.token}`, undefined, null)
    assert.equal(pub.status, 404)
    assert.equal(pub.json.error, 'revoked')
  })

  test('过期链接返回 expired', async () => {
    const { campaign } = await setup()
    const expired = (
      await api('POST', `/api/campaigns/${campaign.id}/links`, { expiresAt: Date.now() - 1000 })
    ).json.link
    const pub = await api('GET', `/public/campaign/${expired.token}`, undefined, null)
    assert.equal(pub.json.error, 'expired')
  })

  test('不传 expiresAt = 永不过期', async () => {
    const { link } = await setup()
    assert.equal(link.expiresAt, undefined)
    assert.equal(link.active, true)
  })

  test('同一工单多条链接互不影响', async () => {
    const { campaign, link } = await setup()
    const second = (await api('POST', `/api/campaigns/${campaign.id}/links`)).json.link
    await api('POST', `/api/campaigns/links/${link.token}/revoke`)
    assert.equal((await api('GET', `/public/campaign/${second.token}`, undefined, null)).status, 200)
    assert.equal((await api('GET', `/api/campaigns/${campaign.id}/links`)).json.links.length, 2)
  })

  test('删除链接：列表移除且公开访问立即 404', async () => {
    const { campaign, link } = await setup()
    assert.equal(
      (await api('DELETE', `/api/campaigns/links/${link.token}`)).status,
      200
    )
    assert.equal((await api('GET', `/api/campaigns/${campaign.id}/links`)).json.links.length, 0)
    const pub = await api('GET', `/public/campaign/${link.token}`, undefined, null)
    assert.equal(pub.status, 404)
    assert.equal(pub.json.error, 'not_found', '删除后如同从未存在，而非 revoked')
  })

  test('伪造令牌无效', async () => {
    const pub = await api('GET', '/public/campaign/deadbeef', undefined, null)
    assert.equal(pub.status, 404)
    assert.equal(pub.json.error, 'not_found')
  })

  test('看板页面本身可以直接打开', async () => {
    const { link } = await setup()
    const res = await app.inject({ method: 'GET', url: `/c/${link.token}` })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.match(res.body, /引流看板/)
  })
})

describe('重粉库接口', () => {
  test('导入脏名单：归一化 + 去重 + 问题行回报', async () => {
    const r = await api('POST', '/api/fan-libraries/import', {
      name: '老粉',
      channel: 'whatsapp',
      contacts: '+86 138 0013 8000\n8613800138000\n+8615900000000\nabc'
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.added, 2)
    assert.equal(r.json.parsed.duplicates, 1)
    assert.equal(r.json.parsed.errors.length, 1)
  })

  test('从历史数据导出建库', async () => {
    await seed('a1', 'wa:+8613800138000', T0)
    await seed('a1', 'wa:+8613900139000', T0)
    const r = await api('POST', '/api/fan-libraries/export', { name: '存量', channel: 'whatsapp' })
    assert.equal(r.json.added, 2)
    assert.equal((await api('GET', '/api/fan-libraries')).json.libraries.length, 1)
  })

  test('不支持建库的平台被拒', async () => {
    const r = await api('POST', '/api/fan-libraries/import', {
      name: 'x',
      channel: 'telegram_bot',
      contacts: '1'
    })
    assert.equal(r.status, 400)
  })

  test('LINE 名单必须给 Provider', async () => {
    const U = 'U' + 'a'.repeat(32)
    const without = await api('POST', '/api/fan-libraries/import', {
      name: 'x',
      channel: 'line',
      contacts: U
    })
    assert.equal(without.status, 400)
    const withProvider = await api('POST', '/api/fan-libraries/import', {
      name: 'x',
      channel: 'line',
      contacts: U,
      lineProvider: 'p1'
    })
    assert.equal(withProvider.json.added, 1)
  })

  test('库参与判重后新粉数下降', async () => {
    await seed('a1', 'wa:+8613800138000', T0 + 3600_000)
    await seed('a1', 'wa:+8613900139000', T0 + 3600_000)
    const lib = (
      await api('POST', '/api/fan-libraries/import', {
        name: '老粉',
        channel: 'whatsapp',
        contacts: '+8613800138000'
      })
    ).json.library

    const c = (
      await api('POST', '/api/campaigns', {
        name: 'x',
        accountIds: ['a1'],
        startAt: T0,
        dedupLibraryIds: [lib.id]
      })
    ).json.campaign

    const stats = (await api('GET', `/api/campaigns/${c.id}/stats`)).json.stats
    assert.equal(stats.total, 2)
    assert.equal(stats.duplicate, 1)
    assert.equal(stats.fresh, 1)
    assert.equal(stats.duplicateBy.library, 1)
  })

  test('追加名单到已有库', async () => {
    const lib = (
      await api('POST', '/api/fan-libraries/import', {
        name: 'x',
        channel: 'whatsapp',
        contacts: '+8613800138000'
      })
    ).json.library
    const r = await api('POST', `/api/fan-libraries/${lib.id}/entries`, {
      contacts: '+8615900000000'
    })
    assert.equal(r.json.added, 1)
  })

  test('删除库', async () => {
    const lib = (
      await api('POST', '/api/fan-libraries/import', {
        name: 'x',
        channel: 'whatsapp',
        contacts: '+8613800138000'
      })
    ).json.library
    assert.equal((await api('DELETE', `/api/fan-libraries/${lib.id}`)).status, 200)
    assert.equal((await api('GET', '/api/fan-libraries')).json.libraries.length, 0)
  })
})

describe('推广入口链接（多条持久化）', () => {
  test('创建多条 → 列表 → 删除；校验必填', async () => {
    const mk = (name: string, code: string) =>
      api('POST', '/api/entry-links', {
        name,
        channel: 'whatsapp',
        accountId: 'a1',
        handle: '+8613800138000',
        code,
        greeting: 'hi'
      })
    assert.equal((await mk('FB广告A', 'fb01')).status, 200)
    assert.equal((await mk('TikTok组B', 'tt02')).status, 200)
    const list = await api('GET', '/api/entry-links')
    assert.equal(list.json.links.length, 2)
    assert.equal(list.json.links[0].name, 'TikTok组B', '新的在前')

    assert.equal((await api('POST', '/api/entry-links', { name: 'x' })).status, 400)

    const id = list.json.links[0].id
    assert.equal((await api('DELETE', `/api/entry-links/${id}`)).status, 200)
    assert.equal((await api('GET', '/api/entry-links')).json.links.length, 1)
  })
})
