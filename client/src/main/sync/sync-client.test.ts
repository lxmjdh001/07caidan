import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncConfig } from '@shared/settings'
import { JsonMessageStore } from '../core/json-message-store'
import type { UnifiedMessage } from '@shared/domain'
import { SyncClient } from './sync-client'

let dir: string
let store: JsonMessageStore

const CFG: SyncConfig = {
  enabled: true,
  serverUrl: 'https://api.test',
  token: 'tok',
  email: 'a@b.com',
  uploadMedia: false
}

function msg(o: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: Math.random().toString(36).slice(2),
    externalId: Math.random().toString(36).slice(2),
    channel: 'whatsapp',
    accountId: 'main',
    conversationId: 'whatsapp:main:1@lid',
    direction: 'in',
    body: { type: 'text', text: 'hi' },
    timestamp: 1000,
    status: 'delivered',
    ...o
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omni-sync-'))
  store = new JsonMessageStore(dir)
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function mockFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, missing: [] }) }))
  vi.stubGlobal('fetch', f)
  return f
}

function syncPosts(f: ReturnType<typeof vi.fn>): Array<[string, { body: string }]> {
  return f.mock.calls.filter(([url, init]) =>
    url === 'https://api.test/api/sync' && (init as { method?: string } | undefined)?.method === 'POST'
  ) as Array<[string, { body: string }]>
}

describe('SyncClient', () => {
  it('禁用/缺配置时不发请求', async () => {
    const f = mockFetch()
    const sc = new SyncClient({
      store,
      getConfig: () => ({ ...CFG, enabled: false }),
      persistRecord: async () => {}
    })
    expect(await sc.runOnce()).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('新设备先从服务器主库回填会话和消息，再执行本地增量上报', async () => {
    const remoteConversation = {
      id: 'whatsapp:main:server@lid',
      channel: 'whatsapp',
      accountId: 'main',
      title: '服务器客户',
      publicId: '@line',
      isGroup: false,
      lastMessageAt: 2000
    }
    const remoteMessage = {
      externalId: 'SERVER-1',
      conversationId: remoteConversation.id,
      channel: 'whatsapp',
      accountId: 'main',
      direction: 'in',
      authorName: '客户',
      bodyType: 'text',
      text: '从服务器恢复',
      timestamp: 2000,
      syncUpdatedAt: 3000
    }
    const f = vi.fn(async (url: string) => {
      if (url.includes('/api/conversations?')) {
        return { ok: true, json: async () => ({ conversations: [remoteConversation] }) }
      }
      if (url.includes('/api/sync/pull?')) {
        return {
          ok: true,
          json: async () => ({ messages: [remoteMessage], conversations: [remoteConversation], cursor: { updatedAt: 3000, externalId: 'SERVER-1' } })
        }
      }
      return { ok: true, json: async () => ({ ok: true, missing: [] }) }
    })
    vi.stubGlobal('fetch', f)
    const received: string[] = []
    const sc = new SyncClient({
      store,
      getConfig: () => CFG,
      persistRecord: async () => {},
      onRemoteMessage: (m) => received.push(m.externalId ?? '')
    })

    await sc.runOnce()

    const restoredConversation = (await store.listConversations()).find((c) => c.id === remoteConversation.id)
    expect(restoredConversation?.publicId).toBe('@line')
    expect((await store.listMessages(remoteConversation.id)).map((m) => m.externalId)).toContain('SERVER-1')
    expect(received).toEqual(['SERVER-1'])
    expect(f.mock.calls.some(([url]) => String(url).includes('/api/sync'))).toBe(true)
  })

  it('把新消息批量 POST 到 /api/sync，并带译文字段', async () => {
    await store.recordMessage(
      msg({
        externalId: 'M1',
        body: { type: 'text', text: 'hello' },
        translation: { text: '你好', targetLang: 'zh-CN', engine: 'x' }
      })
    )
    const f = mockFetch()
    const persisted: number[] = []
    const sc = new SyncClient({
      store,
      getConfig: () => CFG,
      persistRecord: async (r) => {
        persisted.push(r.lastSyncedAt)
      }
    })
    const res = await sc.runOnce()
    expect(res?.messages).toBe(1)

    const call = syncPosts(f)[0]!
    expect(call[0]).toBe('https://api.test/api/sync')
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.messages[0]).toMatchObject({
      externalId: 'M1',
      bodyType: 'text',
      text: 'hello',
      translationText: '你好',
      translationLang: 'zh-CN'
    })
    expect(body.conversations).toHaveLength(1)
    expect(persisted.at(-1)).toBe(1000) // 拉取状态先落盘，最后一次才是本地上行水位
  })

  it('无新消息的历史会话被标记资料变更后，也会随消息批同步', async () => {
    // 建立两个会话 A、B 各一条消息，首次全同步
    await store.recordMessage(msg({ externalId: 'A1', conversationId: 'whatsapp:main:A', timestamp: 1000 }))
    await store.recordMessage(msg({ externalId: 'B1', conversationId: 'whatsapp:main:B', timestamp: 1000 }))
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    mockFetch()
    await sc.runOnce() // 水位=1000，A、B 都传过
    // 之后只有 A 收到新消息；B 无新消息（但回填/刷新了元信息，需要能同步上去）
    await store.recordMessage(msg({ externalId: 'A2', conversationId: 'whatsapp:main:A', timestamp: 2000 }))
    await store.patchConversation({ id: 'whatsapp:main:B', contactId: 'wa:+15550001111' })
    await sc.markConversationDirty('whatsapp:main:B')
    const f = mockFetch()
    await sc.runOnce()
    sc.stop()
    const body = JSON.parse(syncPosts(f)[0]![1].body)
    // 只有 A2 一条新消息
    expect(body.messages.map((m: { externalId: string }) => m.externalId)).toEqual(['A2'])
    // B 虽无新消息，但资料脏标记保证 contactId 等元信息不会漏传。
    expect(body.conversations.map((c: { id: string }) => c.id).sort()).toEqual([
      'whatsapp:main:A',
      'whatsapp:main:B'
    ])
  })

  it('水位推进后不再重复上传旧消息', async () => {
    await store.recordMessage(msg({ externalId: 'M1', timestamp: 1000 }))
    const f = mockFetch()
    let record = { lastSyncedAt: 0, boundaryIds: [] as string[] }
    const make = () =>
      new SyncClient({
        store,
        getConfig: () => CFG,
        initialRecord: record,
        persistRecord: async (r) => {
          record = r
        }
      })
    await make().runOnce()
    f.mockClear()
    // 第二次：无新消息（水位已 >= 1000），不应再 POST（但会轮询服务端增量）。
    const res = await make().runOnce()
    expect(res?.messages ?? 0).toBe(0)
    expect(syncPosts(f)).toHaveLength(0)
  })

  it('同秒边界：水位停在某秒后，同一秒新到的消息(新 externalId)仍上传、不漏、不重传', async () => {
    // 边界水位算法的存在意义：时间戳精确到秒，同一秒的消息可能跨多次同步到达。
    // 「严格晚于水位」会把同秒新消息永远漏掉(数据丢失)；只靠时间戳又会重传已发的同秒消息。
    // 靠 boundaryIds(水位那一秒已发的 externalId 集)区分。这条把这套核心去重钉死。
    const f = mockFetch()
    let record = { lastSyncedAt: 0, boundaryIds: [] as string[] }
    const make = () =>
      new SyncClient({
        store,
        getConfig: () => CFG,
        initialRecord: record,
        persistRecord: async (r) => {
          record = r
        }
      })
    // 第一批：M1 @ 1000 → 水位到 1000，边界集含 M1
    await store.recordMessage(msg({ externalId: 'M1', timestamp: 1000 }))
    await make().runOnce()
    expect(record.lastSyncedAt).toBe(1000)
    expect(record.boundaryIds).toContain('M1')
    f.mockClear()

    // 同一秒又来 M2 @ 1000（新 externalId）→ 必须上传(否则永久丢失)，但不能重传 M1
    await store.recordMessage(msg({ externalId: 'M2', timestamp: 1000 }))
    const res = await make().runOnce()
    expect(res?.messages).toBe(1)
    const sent = JSON.parse(syncPosts(f)[0]![1].body)
    expect(sent.messages.map((m: { externalId: string }) => m.externalId)).toEqual(['M2'])
    // 边界集累积成 M1+M2（union，见实现 line 127）
    expect(new Set(record.boundaryIds)).toEqual(new Set(['M1', 'M2']))
    f.mockClear()

    // 第三次：无新消息 → 不再传（M1/M2 都在边界集里）
    const res3 = await make().runOnce()
    expect(res3?.messages ?? 0).toBe(0)
    expect(syncPosts(f)).toHaveLength(0)
  })

  it('无 externalId 的消息不上传', async () => {
    await store.recordMessage(msg({ externalId: undefined }))
    const f = mockFetch()
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    const res = await sc.runOnce()
    expect(res?.messages ?? 0).toBe(0) // 无可传消息
    expect(syncPosts(f)).toHaveLength(0)
  })

  it('网络失败时吞掉异常返回 null（下周期重试）', async () => {
    await store.recordMessage(msg({ externalId: 'M1' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    )
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    expect(await sc.runOnce()).toBeNull()
  })

  it('没有新消息时，会话备注/语言/置顶等脏资料也会单独同步', async () => {
    await store.recordMessage(msg({ externalId: 'M1', timestamp: 1000 }))
    const conversationId = 'whatsapp:main:1@lid'
    await store.patchConversation({
      id: conversationId,
      customerNote: '重点客户',
      langOverride: 'ja',
      pinned: true,
      muted: true,
      autoReply: true
    })
    const f = mockFetch()
    const sc = new SyncClient({
      store,
      getConfig: () => CFG,
      initialRecord: {
        lastSyncedAt: 1000,
        boundaryIds: ['M1'],
        remoteScope: 'https://api.test|a@b.com',
        remoteConversationsBootstrapped: true,
        remoteMessagesBootstrapped: true
      },
      persistRecord: async () => {}
    })
    await sc.markConversationDirty(conversationId)
    await sc.runOnce()
    sc.stop()
    const body = JSON.parse(syncPosts(f)[0]![1].body)
    expect(body.messages).toEqual([])
    expect(body.conversations[0]).toMatchObject({
      customerNote: '重点客户', langOverride: 'ja', pinned: true, muted: true, autoReply: true
    })
  })

  it('另一台电脑修改的会话资料通过独立增量流更新到本机', async () => {
    const remoteConversation = {
      id: 'line:main:user-1', channel: 'line', accountId: 'main', title: '客户新昵称',
      isGroup: false, detectedLang: 'ko', langOverride: 'ja', autoReply: true,
      pinned: true, muted: true, customerNote: '公司电脑写的备注',
      lastMessagePreview: '最近消息', lastMessageAt: 5000, syncUpdatedAt: 6000
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/sync/conversations?')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [remoteConversation],
            cursor: { updatedAt: 6000, id: remoteConversation.id }
          })
        }
      }
      return { ok: true, json: async () => ({ messages: [], reads: [], conversations: [], cursor: null, missing: [] }) }
    }))
    const sc = new SyncClient({
      store,
      getConfig: () => CFG,
      initialRecord: {
        lastSyncedAt: 0,
        boundaryIds: [],
        remoteScope: 'https://api.test|a@b.com',
        remoteConversationsBootstrapped: true,
        remoteMessagesBootstrapped: true
      },
      persistRecord: async () => {}
    })
    await sc.runOnce()
    expect(await store.getConversation(remoteConversation.id)).toMatchObject({
      title: '客户新昵称', detectedLang: 'ko', langOverride: 'ja', autoReply: true,
      pinned: true, muted: true, customerNote: '公司电脑写的备注'
    })
  })

  it('可重入保护：一次同步进行中，并发再调直接返回 null（不重叠上传、不抢水位）', async () => {
    // 定时器每 N 秒触发一次 runOnce；若上一次还没跑完（网络慢），这一次必须直接跳过，
    // 否则两趟同步会并发上传、争抢水位状态，导致重传或漏传。running 标志就是这个保护。
    await store.recordMessage(msg({ externalId: 'M1', timestamp: 1000 }))
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const f = vi.fn(async (url: string) => {
      if (url === 'https://api.test/api/sync') await gate // 只卡住 POST；服务端拉取应正常完成
      return { ok: true, json: async () => ({ ok: true, missing: [] }) } as unknown as Response
    })
    vi.stubGlobal('fetch', f)
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    const p1 = sc.runOnce() // 进入，running=true，卡在 POST 的 gate
    const p2 = await sc.runOnce() // running 已 true → 直接返回 null
    expect(p2).toBeNull()
    release()
    await p1
    expect(syncPosts(f)).toHaveLength(1) // 只有第一趟真的上传，第二趟被挡下
  })
})
