import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import type { OmniEvent } from '@shared/ipc'
import { ChannelAdapter, type OutboundResult } from './channel-adapter'
import { ChannelManager } from './channel-manager'
import { JsonMessageStore } from './json-message-store'
import { TranslationPipeline } from '../translation/pipeline'
import { PassthroughTranslator } from '../translation/passthrough-translator'

class FakeAdapter extends ChannelAdapter {
  readonly kind = 'whatsapp' as const
  readonly accountId = 'main'
  sendText = vi.fn(async (): Promise<OutboundResult> => ({ externalId: 'SENT1' }))
  start = vi.fn(async () => {})
  stop = vi.fn(async () => {})
  logout = vi.fn(async () => {})

  /** 测试辅助：模拟收到平台消息 */
  fakeIncoming(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
    const msg: UnifiedMessage = {
      id: Math.random().toString(36).slice(2),
      externalId: undefined,
      channel: 'whatsapp',
      accountId: 'main',
      conversationId: 'whatsapp:main:42@s.whatsapp.net',
      direction: 'in',
      authorName: 'Bob',
      body: { type: 'text', text: 'incoming' },
      timestamp: Date.now(),
      status: 'delivered',
      ...overrides
    }
    this.emit('message', msg)
    return msg
  }
}

let dir: string
let store: JsonMessageStore
let adapter: FakeAdapter
let manager: ChannelManager
let events: OmniEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-mgr-'))
  store = new JsonMessageStore(dir)
  await store.init()
  events = []
  manager = new ChannelManager(
    store,
    new TranslationPipeline(new PassthroughTranslator()),
    (evt) => events.push(evt)
  )
  adapter = new FakeAdapter()
  manager.register(adapter)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('ChannelManager', () => {
  it('重复注册同一渠道抛错', () => {
    expect(() => manager.register(new FakeAdapter())).toThrow()
  })

  it('适配器消息 → 入库 + 广播，入站累计未读', async () => {
    adapter.fakeIncoming()
    await flushAsync()

    const evt = events.find((e) => e.type === 'message:new')
    expect(evt).toBeDefined()
    if (evt?.type === 'message:new') {
      expect(evt.message.body).toEqual({ type: 'text', text: 'incoming' })
      expect(evt.conversation.unreadCount).toBe(1)
    }
    expect(await store.listMessages('whatsapp:main:42@s.whatsapp.net')).toHaveLength(1)
  })

  it('重复 externalId 的消息不重复广播', async () => {
    adapter.fakeIncoming({ externalId: 'DUP', id: 'a' })
    adapter.fakeIncoming({ externalId: 'DUP', id: 'b' })
    await flushAsync()
    expect(events.filter((e) => e.type === 'message:new')).toHaveLength(1)
  })

  it('状态事件更新 listChannels 并广播', () => {
    adapter.emit('state', {
      kind: 'whatsapp',
      accountId: 'main',
      status: 'connected',
      selfName: 'Me'
    })
    expect(manager.listChannels()).toEqual([
      { kind: 'whatsapp', accountId: 'main', status: 'connected', selfName: 'Me' }
    ])
    expect(events.some((e) => e.type === 'channel:state')).toBe(true)
  })

  it('conversation 事件修正已有会话标题', async () => {
    adapter.fakeIncoming({ authorName: undefined })
    await flushAsync()
    adapter.emit('conversation', {
      externalChatId: '42@s.whatsapp.net',
      title: '客户老张',
      isGroup: false
    })
    await flushAsync()

    const convs = await store.listConversations()
    expect(convs[0]?.title).toBe('客户老张')
    expect(events.some((e) => e.type === 'conversation:updated')).toBe(true)
  })

  it('sendText 成功：调用适配器、状态 sent、入库并广播', async () => {
    const msg = await manager.sendText('whatsapp:main:42@s.whatsapp.net', 'hi there')
    expect(adapter.sendText).toHaveBeenCalledWith('42@s.whatsapp.net', 'hi there')
    expect(msg.status).toBe('sent')
    expect(msg.externalId).toBe('SENT1')
    expect(msg.direction).toBe('out')

    const stored = await store.listMessages('whatsapp:main:42@s.whatsapp.net')
    expect(stored).toHaveLength(1)
    expect(events.some((e) => e.type === 'message:new')).toBe(true)
  })

  it('sendText 失败：消息标记 failed 但仍入库', async () => {
    adapter.sendText.mockRejectedValueOnce(new Error('network down'))
    const msg = await manager.sendText('whatsapp:main:42@s.whatsapp.net', 'oops')
    expect(msg.status).toBe('failed')
    expect(await store.listMessages('whatsapp:main:42@s.whatsapp.net')).toHaveLength(1)
  })

  it('发往未注册渠道抛错', async () => {
    await expect(manager.sendText('telegram:bot:123', 'x')).rejects.toThrow('未注册')
  })
})
