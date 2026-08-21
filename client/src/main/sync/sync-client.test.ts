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

    const call = f.mock.calls[0]!
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
    expect(persisted[0]).toBe(1000) // 水位推进到最大 timestamp
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
    // 第二次：无新消息（水位已 >= 1000），不应再 POST
    const res = await make().runOnce()
    expect(res?.messages ?? 0).toBe(0)
    expect(f).not.toHaveBeenCalled()
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
    const sent = JSON.parse((f.mock.calls[0]![1] as { body: string }).body)
    expect(sent.messages.map((m: { externalId: string }) => m.externalId)).toEqual(['M2'])
    // 边界集累积成 M1+M2（union，见实现 line 127）
    expect(new Set(record.boundaryIds)).toEqual(new Set(['M1', 'M2']))
    f.mockClear()

    // 第三次：无新消息 → 不再传（M1/M2 都在边界集里）
    const res3 = await make().runOnce()
    expect(res3?.messages ?? 0).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('无 externalId 的消息不上传', async () => {
    await store.recordMessage(msg({ externalId: undefined }))
    const f = mockFetch()
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    const res = await sc.runOnce()
    expect(res?.messages ?? 0).toBe(0) // 无可传消息
    expect(f).not.toHaveBeenCalled()
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

  it('可重入保护：一次同步进行中，并发再调直接返回 null（不重叠上传、不抢水位）', async () => {
    // 定时器每 N 秒触发一次 runOnce；若上一次还没跑完（网络慢），这一次必须直接跳过，
    // 否则两趟同步会并发上传、争抢水位状态，导致重传或漏传。running 标志就是这个保护。
    await store.recordMessage(msg({ externalId: 'M1', timestamp: 1000 }))
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const f = vi.fn(async () => {
      await gate // 卡住第一趟同步的 POST
      return { ok: true, json: async () => ({ ok: true, missing: [] }) } as unknown as Response
    })
    vi.stubGlobal('fetch', f)
    const sc = new SyncClient({ store, getConfig: () => CFG, persistRecord: async () => {} })
    const p1 = sc.runOnce() // 进入，running=true，卡在 POST 的 gate
    const p2 = await sc.runOnce() // running 已 true → 直接返回 null
    expect(p2).toBeNull()
    release()
    await p1
    expect(f).toHaveBeenCalledTimes(1) // 只有第一趟真的发了请求，第二趟被挡下
  })
})
