import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import type { OmniEvent } from '@shared/ipc'
import { writeFile } from 'node:fs/promises'
import {
  ChannelAdapter,
  type GroupSummary,
  type OutboundMedia,
  type OutboundResult
} from './channel-adapter'
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
  override listGroups = vi.fn(async (): Promise<GroupSummary[]> => [])
  override createGroup = vi.fn(async (subject: string, participantIds: string[]): Promise<GroupSummary> => ({
    externalChatId: 'created@g.us',
    title: subject,
    participantIds
  }))
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
  // ChannelManager 的头像/联系人补全是异步触发的，落盘有 500ms 防抖。
  // 先让在途任务完成并强制 flush，再删临时目录，避免 Vitest 报未处理的 ENOENT。
  await new Promise((resolve) => setTimeout(resolve, 550))
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('ChannelManager', () => {
  it('重复注册同一渠道抛错', () => {
    expect(() => manager.register(new FakeAdapter())).toThrow()
  })

  it('unregister：停止适配器、移除状态并广播 channel:removed，之后可重新注册', async () => {
    await manager.unregister('whatsapp:main')
    expect(adapter.stop).toHaveBeenCalled()
    expect(manager.listChannels()).toEqual([])
    expect(events.some((e) => e.type === 'channel:removed' && e.key === 'whatsapp:main')).toBe(true)
    // 移除后事件不再进入管线
    adapter.fakeIncoming()
    await flushAsync()
    expect(events.some((e) => e.type === 'message:new')).toBe(false)
    // 可重新注册同 key
    expect(() => manager.register(new FakeAdapter())).not.toThrow()
  })

  it('unregister 未注册的 key 静默忽略', async () => {
    await expect(manager.unregister('whatsapp:ghost')).resolves.toBeUndefined()
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

  it('禁用账号时丢弃消息并阻止发送，重新启用后恢复', async () => {
    manager.setDisabled('whatsapp:main', true)
    adapter.fakeIncoming()
    await flushAsync()
    expect(events.some((e) => e.type === 'message:new')).toBe(false)
    expect(await store.listMessages('whatsapp:main:42@s.whatsapp.net')).toHaveLength(0)
    await expect(manager.start('whatsapp:main')).rejects.toThrow('账号已禁用')
    await expect(manager.sendText('whatsapp:main:42@s.whatsapp.net', 'blocked')).rejects.toThrow(
      '账号已禁用'
    )

    await manager.setAccountEnabled('whatsapp:main', true)
    expect(adapter.start).toHaveBeenCalled()
    adapter.fakeIncoming()
    await flushAsync()
    expect(events.some((e) => e.type === 'message:new')).toBe(true)
  })

  it('网络门禁失败时不调用适配器，登录前即 fail-closed', async () => {
    const assertReady = vi.fn(async () => { throw new Error('代理未配置，安全隔离已阻止直连') })
    manager.setNetworkPolicy({
      assertReady,
      isUsable: () => false,
      startMonitoring: vi.fn(),
      stopMonitoring: vi.fn()
    })

    await expect(manager.start('whatsapp:main')).rejects.toThrow('阻止直连')
    expect(assertReady).toHaveBeenCalledWith('whatsapp:main')
    expect(adapter.start).not.toHaveBeenCalled()
    expect(manager.listChannels()[0]).toMatchObject({ status: 'error' })
  })

  it('代理监控断线后停止平台连接并切换为安全隔离错误态', async () => {
    let onUnavailable: ((detail: string) => void) | undefined
    manager.setNetworkPolicy({
      assertReady: vi.fn(async () => undefined),
      isUsable: () => true,
      startMonitoring: (_key, callback) => { onUnavailable = callback },
      stopMonitoring: vi.fn()
    })

    await manager.start('whatsapp:main')
    expect(adapter.start).toHaveBeenCalledTimes(1)
    onUnavailable?.('ECONNREFUSED')
    await flushAsync()
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(manager.listChannels()[0]).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('账号已安全隔离')
    })
  })

  it('重复 externalId 的消息不重复广播', async () => {
    adapter.fakeIncoming({ externalId: 'DUP', id: 'a' })
    adapter.fakeIncoming({ externalId: 'DUP', id: 'b' })
    await flushAsync()
    expect(events.filter((e) => e.type === 'message:new')).toHaveLength(1)
  })

  it('手机端发出的消息也入库，但不累计未读或触发入站翻译', async () => {
    adapter.fakeIncoming({
      id: 'mobile-outbound',
      externalId: 'OUT-1',
      direction: 'out',
      body: { type: 'text', text: '手机端回复' }
    })
    await flushAsync()

    const [message] = await store.listMessages('whatsapp:main:42@s.whatsapp.net')
    expect(message).toMatchObject({ direction: 'out', externalId: 'OUT-1' })
    const [conversation] = await store.listConversations()
    expect(conversation?.unreadCount).toBe(0)
  })

  it('登录历史快照静默入库，不累计未读或冒充新消息广播', async () => {
    const historical = adapter.fakeIncoming({ externalId: 'HISTORY-1' })
    await flushAsync()
    await store.clearConversation(historical.conversationId)
    events.length = 0

    adapter.emit('historyMessage', { ...historical, id: 'history-local' })
    await flushAsync()

    expect(await store.listMessages(historical.conversationId)).toHaveLength(1)
    expect((await store.getConversation(historical.conversationId))?.unreadCount).toBe(0)
    expect(events.some((event) => event.type === 'message:new')).toBe(false)
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

  it('连接后拉取账号自身头像并广播到渠道状态', async () => {
    adapter.fetchSelfAvatar = vi.fn(async () => 'self-avatar.jpg')
    adapter.emit('state', {
      kind: 'whatsapp',
      accountId: 'main',
      status: 'connected',
      selfName: 'Me'
    })
    await flushAsync()

    expect(adapter.fetchSelfAvatar).toHaveBeenCalledTimes(1)
    expect(manager.listChannels()[0]?.avatarMediaId).toBe('self-avatar.jpg')
    expect(
      events.some(
        (e) => e.type === 'channel:state' && e.state.avatarMediaId === 'self-avatar.jpg'
      )
    ).toBe(true)

    adapter.emit('state', {
      kind: 'whatsapp',
      accountId: 'main',
      status: 'connected',
      selfName: 'Me'
    })
    await flushAsync()
    expect(adapter.fetchSelfAvatar).toHaveBeenCalledTimes(1)
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

  it('平台登录快照可登记无本地消息的会话摘要', async () => {
    adapter.emit('conversation', {
      externalChatId: 'snapshot-chat',
      title: '历史客户',
      isGroup: false,
      contactId: 'wa:+8613800000000',
      lastMessageAt: 1_700_000_000_000,
      lastMessagePreview: '上一条消息',
      unreadCount: 3
    })
    await flushAsync()

    const conversation = await store.getConversation('whatsapp:main:snapshot-chat')
    expect(conversation).toMatchObject({
      title: '历史客户',
      contactId: 'wa:+8613800000000',
      lastMessagePreview: '上一条消息',
      unreadCount: 3
    })
    expect(await store.listMessages('whatsapp:main:snapshot-chat')).toEqual([])
  })

  it('刷新群组使用平台最新群名，同时保留已有消息摘要', async () => {
    await store.upsertConversation({
      id: 'whatsapp:main:group@g.us',
      channel: 'whatsapp',
      accountId: 'main',
      externalChatId: 'group@g.us',
      title: '旧群名',
      isGroup: true,
      lastMessageAt: 123,
      lastMessagePreview: '历史消息',
      unreadCount: 2
    })
    adapter.listGroups.mockResolvedValueOnce([
      { externalChatId: 'group@g.us', title: '平台最新群名', participantIds: [] }
    ])

    const [group] = await manager.listGroups('whatsapp:main')

    expect(group).toMatchObject({
      title: '平台最新群名',
      isGroup: true,
      lastMessageAt: 123,
      lastMessagePreview: '历史消息',
      unreadCount: 2
    })
    expect((await store.getConversation('whatsapp:main:group@g.us'))?.title).toBe('平台最新群名')
  })

  it('创建群组后登记真实平台群 ID', async () => {
    const group = await manager.createGroup('whatsapp:main', '售后群', ['1@s.whatsapp.net'])

    expect(adapter.createGroup).toHaveBeenCalledWith('售后群', ['1@s.whatsapp.net'])
    expect(group).toMatchObject({
      id: 'whatsapp:main:created@g.us',
      externalChatId: 'created@g.us',
      title: '售后群',
      isGroup: true
    })
  })

  it('公开账号 ID 自动补齐且同一会话只查询一次', async () => {
    adapter.fetchPublicId = vi.fn(async () => '@line')
    adapter.fakeIncoming({ authorName: undefined })
    await flushAsync()

    const [conversation] = await store.listConversations()
    expect(conversation?.publicId).toBe('@line')
    expect(adapter.fetchPublicId).toHaveBeenCalledWith('42@s.whatsapp.net')

    adapter.emit('conversation', {
      externalChatId: '42@s.whatsapp.net',
      title: 'LINE',
      isGroup: false
    })
    await flushAsync()
    expect(adapter.fetchPublicId).toHaveBeenCalledTimes(1)
  })

  it('出站目标语言解析优先级：会话手动 > 检测 > 账号默认 > 全局默认', async () => {
    manager.getLangDefaults = () => ({ accountDefault: 'ja', globalDefault: 'en' })
    const convId = 'whatsapp:main:42@s.whatsapp.net'

    // 无会话记录 → 账号默认
    expect(await manager.resolveTargetLang(convId)).toBe('ja')

    // 无账号默认 → 全局默认
    manager.getLangDefaults = () => ({ globalDefault: 'en' })
    expect(await manager.resolveTargetLang(convId)).toBe('en')

    // 有检测语言 → 用检测
    adapter.fakeIncoming()
    await flushAsync()
    await store.patchConversation({ id: convId, detectedLang: 'es' })
    expect(await manager.resolveTargetLang(convId)).toBe('es')

    // 手动设置最优先
    await store.patchConversation({ id: convId, langOverride: 'fr' })
    expect(await manager.resolveTargetLang(convId)).toBe('fr')

    // 清除手动设置 → 回到检测
    await store.patchConversation({ id: convId, langOverride: null })
    expect(await manager.resolveTargetLang(convId)).toBe('es')
  })

  it('入站消息触发客户语言检测并写入会话', async () => {
    const detecting = new TranslationPipeline(
      { name: 'det', translate: async (text) => ({ text: `[译]${text}`, sourceLang: 'pt' }) },
      { inboundEnabled: true, outboundEnabled: false, displayLang: 'zh-CN' }
    )
    const mgr = new ChannelManager(store, detecting, (evt) => events.push(evt), noopLogger)
    const a2 = new FakeAdapter()
    mgr.register(a2)
    a2.fakeIncoming({ body: { type: 'text', text: 'ola tudo bem' } })
    await flushAsync()

    const conv = await store.getConversation('whatsapp:main:42@s.whatsapp.net')
    expect(conv?.detectedLang).toBe('pt')
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

  it('previewOutbound 返回翻译与目标语言；sendText 传入 prepared 不重复翻译', async () => {
    const upper = new TranslationPipeline(
      { name: 'upper', translate: async (text) => ({ text: text.toUpperCase() }) },
      { inboundEnabled: false, outboundEnabled: true, displayLang: 'zh-CN' }
    )
    const spy = vi.spyOn(upper, 'processOutbound')
    const mgr = new ChannelManager(store, upper, (evt) => events.push(evt), noopLogger)
    const a2 = new FakeAdapter()
    mgr.register(a2)
    mgr.getLangDefaults = () => ({ globalDefault: 'en' })

    const preview = await mgr.previewOutbound('whatsapp:main:42@s.whatsapp.net', 'hello')
    expect(preview).toEqual({ send: 'HELLO', original: 'hello', engine: 'upper', targetLang: 'en' })

    spy.mockClear()
    const msg = await mgr.sendText('whatsapp:main:42@s.whatsapp.net', 'hello', preview)
    expect(spy).not.toHaveBeenCalled()
    expect(msg.body).toEqual({ type: 'text', text: 'HELLO' })
    expect(msg.translation).toMatchObject({ text: 'hello', targetLang: 'en', engine: 'upper' })
    expect(a2.sendText).toHaveBeenCalledWith('42@s.whatsapp.net', 'HELLO')
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

  it('sendVoice：带 ptt 语音条标记发出、ext 按 mime、时长下限 1s、入库广播', async () => {
    // ptt=true 是语音条的关键标记 —— 缺了 WhatsApp 会把它渲染成普通音频文件附件而非语音气泡。
    // durationSec 0.3 → max(1,round)=1（下限 1 秒，避免 0 秒条）。ogg mime → voice.ogg。
    const msg = await manager.sendVoice(
      'whatsapp:main:42@s.whatsapp.net',
      new Uint8Array([1, 2, 3]),
      'audio/ogg; codecs=opus',
      0.3
    )
    expect(msg.status).toBe('sent')
    expect(msg.body).toMatchObject({
      type: 'media',
      mediaType: 'audio',
      fileName: 'voice.ogg',
      durationSec: 1
    })
    // 媒体确实落库，且 mediaId 保留真实扩展名（.ogg，不是丢成 .bin）
    if (msg.body.type === 'media') {
      expect(media.resolvePath(msg.body.mediaId!)).toBeTruthy()
      expect(msg.body.mediaId).toMatch(/\.ogg$/)
    }
    const call = adapter.sendMedia.mock.calls[0]!
    expect(call[1].ptt).toBe(true) // 关键：语音条标记
    expect(call[1].mediaType).toBe('audio')
    expect(call[1].fileName).toBe('voice.ogg')
    expect(call[1].durationSec).toBe(1)
    expect(events.some((e) => e.type === 'message:new')).toBe(true)
  })

  it('sendVoice：webm mime → voice.webm；发送失败仍入库', async () => {
    adapter.sendMedia.mockRejectedValueOnce(new Error('net down'))
    const msg = await manager.sendVoice(
      'whatsapp:main:42@s.whatsapp.net',
      new Uint8Array([9]),
      'audio/webm',
      5
    )
    expect(msg.status).toBe('failed')
    expect(msg.body).toMatchObject({ mediaType: 'audio', fileName: 'voice.webm', durationSec: 5 })
    expect(await store.listMessages('whatsapp:main:42@s.whatsapp.net')).toHaveLength(1)
  })
})
