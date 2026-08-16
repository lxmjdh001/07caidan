import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import type { OmniEvent } from '@shared/ipc'
import { writeFile } from 'node:fs/promises'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from './channel-adapter'
import { ChannelManager } from './channel-manager'
import { JsonContactStore } from './contact-store'
import { JsonMessageStore } from './json-message-store'
import { MediaStore } from './media-store'
import { noopLogger } from './logger'
import { TranslationPipeline } from '../translation/pipeline'
import { PassthroughTranslator } from '../translation/passthrough-translator'

class FakeAdapter extends ChannelAdapter {
  readonly kind = 'whatsapp' as const
  readonly accountId = 'main'
  sendText = vi.fn(async (): Promise<OutboundResult> => ({ externalId: 'SENT1' }))
  override sendMedia = vi.fn(
    async (_chatId: string, _media: OutboundMedia): Promise<OutboundResult> => ({
      externalId: 'MEDIA1'
    })
  )
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
let media: MediaStore
let contacts: JsonContactStore
let adapter: FakeAdapter
let manager: ChannelManager
let events: OmniEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-mgr-'))
  store = new JsonMessageStore(dir)
  await store.init()
  media = new MediaStore(join(dir, 'media'))
  await media.init()
  contacts = new JsonContactStore(dir)
  await contacts.init()
  events = []
  manager = new ChannelManager(
    store,
    new TranslationPipeline(new PassthroughTranslator()),
    (evt) => events.push(evt),
    noopLogger,
    media,
    contacts
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

  it('messageUpdate 事件：已存消息被替换并广播 message:updated', async () => {
    const original = adapter.fakeIncoming({
      body: { type: 'media', mediaType: 'image' },
      externalId: 'M1'
    })
    await flushAsync()

    adapter.emit('messageUpdate', {
      ...original,
      body: { type: 'media', mediaType: 'image', mediaId: 'x.jpg' }
    })
    await flushAsync()

    const updatedEvt = events.find((e) => e.type === 'message:updated')
    expect(updatedEvt).toBeDefined()
    const stored = await store.listMessages(original.conversationId)
    expect(stored[0]?.body).toMatchObject({ mediaId: 'x.jpg' })
  })

  it('未入库消息的 messageUpdate 不广播', async () => {
    const ghost: UnifiedMessage = {
      id: 'never-stored',
      channel: 'whatsapp',
      accountId: 'main',
      conversationId: 'whatsapp:main:42@s.whatsapp.net',
      direction: 'in',
      body: { type: 'media', mediaType: 'image', mediaId: 'x.jpg' },
      timestamp: Date.now(),
      status: 'delivered'
    }
    adapter.emit('messageUpdate', ghost)
    await flushAsync()
    expect(events.filter((e) => e.type === 'message:updated')).toHaveLength(0)
  })

  it('sendMediaFile：复制进媒体库、适配器发出、入库并广播', async () => {
    const src = join(dir, 'photo.jpg')
    await writeFile(src, 'jpeg-bytes')

    const msg = await manager.sendMediaFile('whatsapp:main:42@s.whatsapp.net', src)
    expect(msg.status).toBe('sent')
    expect(msg.externalId).toBe('MEDIA1')
    expect(msg.body).toMatchObject({ type: 'media', mediaType: 'image', mimeType: 'image/jpeg' })
    if (msg.body.type === 'media') {
      expect(media.resolvePath(msg.body.mediaId!)).toBeTruthy()
    }

    const call = adapter.sendMedia.mock.calls[0]!
    expect(call[0]).toBe('42@s.whatsapp.net')
    expect(call[1].mediaType).toBe('image')
    expect(call[1].fileName).toBe('photo.jpg')

    expect(await store.listMessages('whatsapp:main:42@s.whatsapp.net')).toHaveLength(1)
    expect(events.some((e) => e.type === 'message:new')).toBe(true)
  })

  it('新会话自动拉取头像并广播 conversation:updated，且只尝试一次', async () => {
    adapter.fetchAvatar = vi.fn(async () => 'avatar-1.jpg')
    adapter.fakeIncoming()
    await flushAsync()
    adapter.fakeIncoming({ id: 'second' })
    await flushAsync()

    expect(adapter.fetchAvatar).toHaveBeenCalledTimes(1)
    const convs = await store.listConversations()
    expect(convs[0]?.avatarMediaId).toBe('avatar-1.jpg')
    const evt = events.find(
      (e) => e.type === 'conversation:updated' && e.conversation.avatarMediaId === 'avatar-1.jpg'
    )
    expect(evt).toBeDefined()
  })

  it('标题仍是平台 ID 时自动解析（fetchTitle），已有标题的不再解析', async () => {
    adapter.fetchTitle = vi.fn(async () => '测试群')
    adapter.fakeIncoming({ authorName: undefined })
    await flushAsync()

    expect(adapter.fetchTitle).toHaveBeenCalledWith('42@s.whatsapp.net')
    const convs = await store.listConversations()
    expect(convs[0]?.title).toBe('测试群')

    // 已有标题的新消息不会再次触发解析
    adapter.fakeIncoming({ id: 'x2', authorName: undefined })
    await flushAsync()
    expect(adapter.fetchTitle).toHaveBeenCalledTimes(1)
  })

  it('解析并登记客户唯一标识（contactId），写入会话与联系人登记表', async () => {
    adapter.resolveContactId = vi.fn(async () => 'wa:+17759276114')
    adapter.fakeIncoming()
    await flushAsync()

    const convs = await store.listConversations()
    expect(convs[0]?.contactId).toBe('wa:+17759276114')
    expect(contacts.get('wa:+17759276114')?.conversationIds).toEqual([
      'whatsapp:main:42@s.whatsapp.net'
    ])
  })

  it('头像拉取失败不影响消息流程', async () => {
    adapter.fetchAvatar = vi.fn(async () => {
      throw new Error('404')
    })
    adapter.fakeIncoming()
    await flushAsync()
    expect(events.some((e) => e.type === 'message:new')).toBe(true)
  })

  it('sendMediaFile 失败：状态 failed 仍入库', async () => {
    adapter.sendMedia.mockRejectedValueOnce(new Error('upload failed'))
    const src = join(dir, 'clip.mp4')
    await writeFile(src, 'mp4-bytes')
    const msg = await manager.sendMediaFile('whatsapp:main:42@s.whatsapp.net', src)
    expect(msg.status).toBe('failed')
    expect(msg.body).toMatchObject({ mediaType: 'video' })
  })
})
