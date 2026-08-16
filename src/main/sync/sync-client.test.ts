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
})
