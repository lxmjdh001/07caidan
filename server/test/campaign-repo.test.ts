import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { CampaignRepo, type Campaign } from '../src/campaign-repo.ts'
import { openDb } from '../src/db.ts'
import { Repo } from '../src/repo.ts'
import type { SyncPayload } from '../src/types.ts'

const T = 'tenant-1'
const DAY = 86_400_000
/** 2026-08-16 00:00 UTC+8 */
const T0 = Date.UTC(2026, 7, 15, 16, 0, 0)

let dir: string
let repo: Repo
let campaigns: CampaignRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-campaign-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  repo = new Repo(db)
  campaigns = new CampaignRepo(db)
})

/** 造一条「某账号和某客户的往来」：入站时间 + 可选回复时间 */
function seed(o: {
  accountId: string
  contactId: string
  channel?: string
  inAt: number
  outAt?: number
  convId?: string
}): void {
  const channel = o.channel ?? 'whatsapp'
  const convId = o.convId ?? `${channel}:${o.accountId}:${o.contactId}`
  const payload: SyncPayload = {
    conversations: [
      {
        id: convId,
        channel,
        accountId: o.accountId,
        contactId: o.contactId,
        title: 'x',
        isGroup: false,
        lastMessageAt: o.inAt
      }
    ],
    messages: [
      {
        externalId: `${convId}:in:${o.inAt}`,
        conversationId: convId,
        channel,
        accountId: o.accountId,
        direction: 'in',
        bodyType: 'text',
        text: 'hi',
        timestamp: o.inAt
      }
    ]
  }
  if (o.outAt !== undefined) {
    payload.messages.push({
      externalId: `${convId}:out:${o.outAt}`,
      conversationId: convId,
      channel,
      accountId: o.accountId,
      direction: 'out',
      bodyType: 'text',
      text: 'hello',
      timestamp: o.outAt
    })
  }
  repo.ingest(T, payload)
}

function makeCampaign(o: Partial<Parameters<CampaignRepo['createCampaign']>[1]> = {}): Campaign {
  return campaigns.createCampaign(T, {
    name: '八月推广',
    accountIds: ['a1'],
    startAt: T0,
    ...o
  })
}

describe('工单 CRUD', () => {
  test('创建后可查询，JSON 字段正确还原', () => {
    const c = makeCampaign({ accountIds: ['a1', 'a2'], dedupLibraryIds: ['L1'], endAt: T0 + DAY })
    const got = campaigns.getCampaign(T, c.id)
    assert.deepEqual(got?.accountIds, ['a1', 'a2'])
    assert.deepEqual(got?.dedupLibraryIds, ['L1'])
    assert.equal(got?.endAt, T0 + DAY)
    assert.equal(got?.tzOffsetMinutes, 480)
  })

  test('不填结束时间 = 持续进行', () => {
    assert.equal(makeCampaign().endAt, undefined)
  })

  test('租户隔离：别的租户看不到', () => {
    makeCampaign()
    assert.equal(campaigns.listCampaigns('other').length, 0)
  })

  test('更新与删除', () => {
    const c = makeCampaign()
    assert.equal(campaigns.updateCampaign(T, c.id, { name: '改名' }), true)
    assert.equal(campaigns.getCampaign(T, c.id)?.name, '改名')
    assert.equal(campaigns.deleteCampaign(T, c.id), true)
    assert.equal(campaigns.getCampaign(T, c.id), null)
  })

  test('删除工单会连带清掉分享链接', () => {
    const c = makeCampaign()
    const link = campaigns.createLink(T, c.id)
    campaigns.deleteCampaign(T, c.id)
    assert.equal(campaigns.resolveLink(link.token).ok, false)
  })
})

describe('分享链接', () => {
  test('默认永不过期', () => {
    const c = makeCampaign()
    const link = campaigns.createLink(T, c.id, { label: '给团队' })
    assert.equal(link.expiresAt, undefined)
    assert.equal(link.active, true)
    const r = campaigns.resolveLink(link.token)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.campaign.id, c.id)
  })

  test('到期后自动失效', () => {
    const c = makeCampaign()
    const link = campaigns.createLink(T, c.id, { expiresAt: 1000 })
    const r = campaigns.resolveLink(link.token, 1001)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'expired')
    // 到期前仍可访问
    assert.equal(campaigns.resolveLink(link.token, 999).ok, true)
  })

  test('手动失效立即生效，且原因与过期区分开', () => {
    const c = makeCampaign()
    const link = campaigns.createLink(T, c.id)
    assert.equal(campaigns.revokeLink(T, link.token), true)
    const r = campaigns.resolveLink(link.token)
    assert.equal(r.ok === false && r.reason, 'revoked')
  })

  test('一个工单可以有多条链接，各自独立', () => {
    const c = makeCampaign()
    const a = campaigns.createLink(T, c.id, { label: 'A' })
    const b = campaigns.createLink(T, c.id, { label: 'B' })
    campaigns.revokeLink(T, a.token)
    assert.equal(campaigns.resolveLink(a.token).ok, false)
    assert.equal(campaigns.resolveLink(b.token).ok, true)
    assert.equal(campaigns.listLinks(T, c.id).length, 2)
  })

  test('令牌不可猜：足够长且各不相同', () => {
    const c = makeCampaign()
    const tokens = new Set(Array.from({ length: 20 }, () => campaigns.createLink(T, c.id).token))
    assert.equal(tokens.size, 20)
    for (const t of tokens) assert.ok(t.length >= 32)
  })

  test('不存在的令牌', () => {
    const r = campaigns.resolveLink('nope')
    assert.equal(r.ok === false && r.reason, 'not_found')
  })

  test('别的租户撤销不了我的链接', () => {
    const c = makeCampaign()
    const link = campaigns.createLink(T, c.id)
    assert.equal(campaigns.revokeLink('other', link.token), false)
    assert.equal(campaigns.resolveLink(link.token).ok, true)
  })
})

describe('重粉库', () => {
  test('导入去重，重复加入不重复计数', () => {
    const lib = campaigns.createLibrary(T, '老粉', 'whatsapp', 'import')
    assert.equal(campaigns.addEntries(T, lib.id, ['wa:+1', 'wa:+2']), 2)
    assert.equal(campaigns.addEntries(T, lib.id, ['wa:+2', 'wa:+3']), 1)
    assert.equal(campaigns.getLibrary(T, lib.id)?.entryCount, 3)
  })

  test('从历史会话导出，只取本平台非群聊', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 })
    seed({ accountId: 'a1', contactId: 'tg:9', channel: 'telegram', inAt: T0 })
    const { library, added } = campaigns.exportToLibrary(T, '存量', 'whatsapp')
    assert.equal(added, 2)
    assert.equal(library.entryCount, 2)
    const set = campaigns.libraryContacts(T, [library.id])
    assert.deepEqual([...set].sort(), ['wa:+1', 'wa:+2'])
  })

  test('导出支持按账号和时间范围过滤', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 })
    seed({ accountId: 'a2', contactId: 'wa:+2', inAt: T0 })
    seed({ accountId: 'a1', contactId: 'wa:+3', inAt: T0 + 10 * DAY })
    const byAccount = campaigns.contactIdsOfChannel(T, 'whatsapp', { accountIds: ['a1'] })
    assert.deepEqual(byAccount.sort(), ['wa:+1', 'wa:+3'])
    const byTime = campaigns.contactIdsOfChannel(T, 'whatsapp', { to: T0 + DAY })
    assert.deepEqual(byTime.sort(), ['wa:+1', 'wa:+2'])
  })

  test('删除库会清掉条目', () => {
    const lib = campaigns.createLibrary(T, 'x', 'whatsapp', 'import')
    campaigns.addEntries(T, lib.id, ['wa:+1'])
    campaigns.deleteLibrary(T, lib.id)
    assert.equal(campaigns.libraryContacts(T, [lib.id]).size, 0)
  })

  test('多个库合并判重（取并集）', () => {
    const l1 = campaigns.createLibrary(T, 'A', 'whatsapp', 'import')
    const l2 = campaigns.createLibrary(T, 'B', 'whatsapp', 'import')
    campaigns.addEntries(T, l1.id, ['wa:+1'])
    campaigns.addEntries(T, l2.id, ['wa:+2'])
    assert.deepEqual([...campaigns.libraryContacts(T, [l1.id, l2.id])].sort(), ['wa:+1', 'wa:+2'])
  })
})

describe('线索归集', () => {
  test('只统计工单账号、窗口内、有入站消息的私聊', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000 })
    seed({ accountId: 'a9', contactId: 'wa:+2', inAt: T0 + 3600_000 }) // 不在工单里
    seed({ accountId: 'a1', contactId: 'wa:+3', inAt: T0 - DAY }) // 开始之前
    const leads = campaigns.leadsOf(T, makeCampaign({ accountIds: ['a1'] }))
    assert.deepEqual(
      leads.map((l) => l.contactId),
      ['wa:+1']
    )
  })

  test('同一客户被多个账号触达：只算一个，归属首次接触的账号', () => {
    seed({ accountId: 'a2', contactId: 'wa:+1', inAt: T0 + 2 * 3600_000, convId: 'c-a2' })
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 1 * 3600_000, convId: 'c-a1' })
    const leads = campaigns.leadsOf(T, makeCampaign({ accountIds: ['a1', 'a2'] }))
    assert.equal(leads.length, 1)
    assert.equal(leads[0]!.accountId, 'a1')
  })

  test('结束时间之后的进线不计入', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + DAY })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 + 5 * DAY })
    const leads = campaigns.leadsOf(T, makeCampaign({ endAt: T0 + 2 * DAY }))
    assert.deepEqual(
      leads.map((l) => l.contactId),
      ['wa:+1']
    )
  })

  test('记录首次回复时间', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000, outAt: T0 + 3900_000 })
    const leads = campaigns.leadsOf(T, makeCampaign())
    assert.equal(leads[0]!.firstReplyAt, T0 + 3900_000)
  })

  test('没有账号的工单返回空而不是全量', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000 })
    assert.deepEqual(campaigns.leadsOf(T, makeCampaign({ accountIds: [] })), [])
  })
})

describe('统计（端到端）', () => {
  test('库判重 + 时间判重取并集', () => {
    // 老粉：库里有
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000 })
    // 老粉：工单开始前就聊过
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 - 10 * DAY, convId: 'old-2' })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 + 3600_000, convId: 'new-2' })
    // 新粉
    seed({ accountId: 'a1', contactId: 'wa:+3', inAt: T0 + 3600_000 })

    const lib = campaigns.createLibrary(T, '老粉库', 'whatsapp', 'import')
    campaigns.addEntries(T, lib.id, ['wa:+1'])

    const c = makeCampaign({ dedupLibraryIds: [lib.id], dedupBeforeAt: T0 })
    const stats = campaigns.statsOf(T, c, { a1: '主号' }, T0 + DAY)

    assert.equal(stats.total, 3)
    assert.equal(stats.duplicate, 2)
    assert.equal(stats.fresh, 1)
    assert.equal(stats.effective, 1)
    assert.deepEqual(stats.duplicateBy, { library: 1, timeRange: 1 })
    assert.equal(stats.byAccount[0]!.label, '主号')
  })

  test('不配任何判重规则时全是新粉', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 - 10 * DAY, convId: 'old' })
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000, convId: 'new' })
    const stats = campaigns.statsOf(T, makeCampaign(), {}, T0 + DAY)
    assert.equal(stats.duplicate, 0)
    assert.equal(stats.fresh, 1)
  })

  test('趋势按天补齐空白', () => {
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000 })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 + 2 * DAY + 3600_000 })
    const stats = campaigns.statsOf(T, makeCampaign(), {}, T0 + 2 * DAY + 7200_000)
    assert.deepEqual(
      stats.byDay.map((d) => [d.date, d.total]),
      [
        ['2026-08-16', 1],
        ['2026-08-17', 0],
        ['2026-08-18', 1]
      ]
    )
  })

  test('公开统计里不含任何粉丝身份信息', () => {
    seed({ accountId: 'a1', contactId: 'wa:+8613800138000', inAt: T0 + 3600_000 })
    const dumped = JSON.stringify(campaigns.statsOf(T, makeCampaign(), {}, T0 + DAY))
    assert.equal(dumped.includes('8613800138000'), false)
    assert.equal(dumped.includes('contactId'), false)
  })
})

describe('时间判重的账号范围', () => {
  test('限定账号：只有在指定账号上出现过才算重复', () => {
    // wa:+1 的历史在 a8 上，wa:+2 的历史在 a9 上
    seed({ accountId: 'a8', contactId: 'wa:+1', inAt: T0 - 10 * DAY, convId: 'h1' })
    seed({ accountId: 'a9', contactId: 'wa:+2', inAt: T0 - 10 * DAY, convId: 'h2' })
    // 两个人都在工单期内从 a1 进线
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000, convId: 'n1' })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 + 3600_000, convId: 'n2' })

    const c = makeCampaign({ dedupBeforeAt: T0, dedupAccountIds: ['a8'] })
    const stats = campaigns.statsOf(T, c, {}, T0 + DAY)
    assert.equal(stats.total, 2)
    assert.equal(stats.duplicate, 1) // 只有 wa:+1 命中
    assert.equal(stats.fresh, 1)
  })

  test('不限定账号（空数组）= 全部账号的历史都算', () => {
    seed({ accountId: 'a8', contactId: 'wa:+1', inAt: T0 - 10 * DAY, convId: 'h1' })
    seed({ accountId: 'a9', contactId: 'wa:+2', inAt: T0 - 10 * DAY, convId: 'h2' })
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000, convId: 'n1' })
    seed({ accountId: 'a1', contactId: 'wa:+2', inAt: T0 + 3600_000, convId: 'n2' })

    const c = makeCampaign({ dedupBeforeAt: T0, dedupAccountIds: [] })
    assert.equal(campaigns.statsOf(T, c, {}, T0 + DAY).duplicate, 2)
  })

  test('限定的账号里没有该客户历史 → 不算重复', () => {
    seed({ accountId: 'a8', contactId: 'wa:+1', inAt: T0 - 10 * DAY, convId: 'h1' })
    seed({ accountId: 'a1', contactId: 'wa:+1', inAt: T0 + 3600_000, convId: 'n1' })
    const c = makeCampaign({ dedupBeforeAt: T0, dedupAccountIds: ['a7'] })
    assert.equal(campaigns.statsOf(T, c, {}, T0 + DAY).duplicate, 0)
  })
})

describe('工单统计 TTL 缓存', () => {
  const H = 3600_000

  test('TTL 内命中：返回同一对象，且不反映期间的新进线', () => {
    seed({ accountId: 'a1', contactId: 'c1', inAt: T0 + H })
    const c = makeCampaign({ accountIds: ['a1'] })
    const s1 = campaigns.statsOf(T, c, undefined, T0 + DAY)
    assert.equal(s1.total, 1)
    // 期间来了新粉
    seed({ accountId: 'a1', contactId: 'c2', inAt: T0 + 2 * H })
    const s2 = campaigns.statsOf(T, c, undefined, T0 + DAY + 10_000)
    assert.equal(s2, s1, '30s 内应命中缓存，返回同一对象引用')
    assert.equal(s2.total, 1, '缓存期内不反映新进线')
  })

  test('TTL 过期后重算，反映最新数据', () => {
    seed({ accountId: 'a1', contactId: 'c1', inAt: T0 + H })
    const c = makeCampaign({ accountIds: ['a1'] })
    assert.equal(campaigns.statsOf(T, c, undefined, T0 + DAY).total, 1)
    seed({ accountId: 'a1', contactId: 'c2', inAt: T0 + 2 * H })
    // 超过 30s TTL
    const s = campaigns.statsOf(T, c, undefined, T0 + DAY + 31_000)
    assert.equal(s.total, 2, '过期后应重算并看到新进线')
  })

  test('工单被改（updatedAt 变）即失效', () => {
    seed({ accountId: 'a1', contactId: 'c1', inAt: T0 + H })
    const c = makeCampaign({ accountIds: ['a1'] })
    assert.equal(campaigns.statsOf(T, c, undefined, T0 + DAY).total, 1)
    seed({ accountId: 'a1', contactId: 'c2', inAt: T0 + 2 * H })
    // 模拟工单被编辑：updatedAt 变化 → 缓存 key 变 → 重算
    const edited = { ...c, updatedAt: c.updatedAt + 1 }
    const s = campaigns.statsOf(T, edited, undefined, T0 + DAY + 5_000)
    assert.equal(s.total, 2, 'updatedAt 变化后应重算')
  })

  test('传自定义 labels 绕过缓存，始终现算', () => {
    seed({ accountId: 'a1', contactId: 'c1', inAt: T0 + H })
    const c = makeCampaign({ accountIds: ['a1'] })
    campaigns.statsOf(T, c, undefined, T0 + DAY) // 先填一次缓存
    seed({ accountId: 'a1', contactId: 'c2', inAt: T0 + 2 * H })
    const s = campaigns.statsOf(T, c, { a1: '主号' }, T0 + DAY + 5_000)
    assert.equal(s.total, 2, '带 labels 的调用不吃缓存')
  })

  test('invalidateStats 清空后立即重算', () => {
    seed({ accountId: 'a1', contactId: 'c1', inAt: T0 + H })
    const c = makeCampaign({ accountIds: ['a1'] })
    assert.equal(campaigns.statsOf(T, c, undefined, T0 + DAY).total, 1)
    seed({ accountId: 'a1', contactId: 'c2', inAt: T0 + 2 * H })
    campaigns.invalidateStats()
    assert.equal(campaigns.statsOf(T, c, undefined, T0 + DAY + 5_000).total, 2)
  })
})
