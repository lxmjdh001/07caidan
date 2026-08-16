import { randomUUID } from 'node:crypto'
import type { ChannelState, UnifiedMessage } from '@shared/domain'
import { conversationId, parseConversationId } from '@shared/domain'
import type { OmniEvent } from '@shared/ipc'
import { basename } from 'node:path'
import type { TranslationPipeline } from '../translation/pipeline'
import type { ChannelAdapter } from './channel-adapter'
import { noopLogger, type Logger } from './logger'
import type { MediaStore } from './media-store'
import type { MessageStore } from './message-store'
import { mediaTypeFromMime, mimeFromPath } from './mime'

/**
 * 渠道管理器：持有所有适配器实例，把它们的事件汇入
 * 翻译管道 → 存储 → 推送给 UI 这条统一链路，并把 UI 的发送请求路由回对应适配器。
 */
export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly states = new Map<string, ChannelState>()
  /** 已尝试拉取头像的会话（避免重复请求，无论成败本次运行只试一次） */
  private readonly avatarAttempted = new Set<string>()
  /** 已尝试解析标题的会话 */
  private readonly titleAttempted = new Set<string>()

  constructor(
    private readonly store: MessageStore,
    private readonly translation: TranslationPipeline,
    private readonly broadcast: (evt: OmniEvent) => void,
    private readonly logger: Logger = noopLogger,
    private readonly media?: MediaStore
  ) {}

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.key)) {
      throw new Error(`渠道已注册: ${adapter.key}`)
    }
    this.adapters.set(adapter.key, adapter)
    this.states.set(adapter.key, {
      kind: adapter.kind,
      accountId: adapter.accountId,
      status: 'stopped'
    })

    adapter.on('state', (state) => {
      this.states.set(adapter.key, state)
      this.broadcast({ type: 'channel:state', state })
      // 连接就绪后为该渠道的历史会话补拉头像
      if (state.status === 'connected') {
        void this.store.listConversations().then((list) => {
          for (const conv of list) {
            if (conv.channel === adapter.kind && conv.accountId === adapter.accountId) {
              this.ensureAvatar(conv)
              this.ensureTitle(conv)
            }
          }
        })
      }
    })

    adapter.on('message', (msg) => {
      void this.handleIncoming(msg)
    })

    adapter.on('messageUpdate', (msg) => {
      void this.store.updateMessage(msg).then((updated) => {
        if (updated) this.broadcast({ type: 'message:updated', message: msg })
      })
    })

    adapter.on('conversation', (upsert) => {
      const id = conversationId(adapter.kind, adapter.accountId, upsert.externalChatId)
      void this.store
        .patchConversation({ id, title: upsert.title, isGroup: upsert.isGroup })
        .then((conv) => {
          if (conv) this.broadcast({ type: 'conversation:updated', conversation: conv })
        })
    })
  }

  listChannels(): ChannelState[] {
    return [...this.states.values()]
  }

  async start(key: string): Promise<void> {
    await this.requireAdapter(key).start()
  }

  async startAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.start()))
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()))
  }

  async logout(key: string): Promise<void> {
    await this.requireAdapter(key).logout()
  }

  /** UI 发送文本：翻译（可选）→ 适配器发出 → 入库 → 回推 UI */
  async sendText(convId: string, text: string): Promise<UnifiedMessage> {
    const { channel, accountId, externalChatId } = parseConversationId(convId)
    const adapter = this.requireAdapter(`${channel}:${accountId}`)

    // 目标语言暂按会话维度配置（后续接入设置）；当前默认不翻译出站
    const outbound = await this.translation.processOutbound(text, 'auto')

    const msg: UnifiedMessage = {
      id: randomUUID(),
      channel,
      accountId,
      conversationId: convId,
      direction: 'out',
      body: { type: 'text', text: outbound.send },
      timestamp: Date.now(),
      status: 'pending'
    }

    try {
      const result = await adapter.sendText(externalChatId, outbound.send)
      msg.status = 'sent'
      msg.externalId = result.externalId
    } catch (err) {
      msg.status = 'failed'
      this.logger.error(`[${adapter.key}] 发送失败`, err)
    }

    const { conversation } = await this.store.recordMessage(msg)
    this.broadcast({ type: 'message:new', message: msg, conversation })
    return msg
  }

  /** UI 发送本地文件：复制进 MediaStore → 适配器发出 → 入库 → 回推 UI */
  async sendMediaFile(convId: string, filePath: string): Promise<UnifiedMessage> {
    if (!this.media) throw new Error('MediaStore 未配置')
    const { channel, accountId, externalChatId } = parseConversationId(convId)
    const adapter = this.requireAdapter(`${channel}:${accountId}`)
    if (!adapter.sendMedia) throw new Error(`渠道 ${adapter.key} 暂不支持发送媒体`)

    const mimeType = mimeFromPath(filePath)
    const mediaType = mediaTypeFromMime(mimeType)
    const fileName = basename(filePath)
    const mediaId = await this.media.importFile(filePath)
    const localPath = this.media.resolvePath(mediaId)!

    const msg: UnifiedMessage = {
      id: randomUUID(),
      channel,
      accountId,
      conversationId: convId,
      direction: 'out',
      body: { type: 'media', mediaType, mediaId, mimeType, fileName },
      timestamp: Date.now(),
      status: 'pending'
    }

    try {
      const result = await adapter.sendMedia(externalChatId, {
        filePath: localPath,
        mediaType,
        mimeType,
        fileName
      })
      msg.status = 'sent'
      msg.externalId = result.externalId
    } catch (err) {
      msg.status = 'failed'
      this.logger.error(`[${adapter.key}] 媒体发送失败`, err)
    }

    const { conversation } = await this.store.recordMessage(msg)
    this.broadcast({ type: 'message:new', message: msg, conversation })
    this.ensureAvatar(conversation)
    this.ensureTitle(conversation)
    return msg
  }

  private async handleIncoming(raw: UnifiedMessage): Promise<void> {
    try {
      const msg = await this.translation.processInbound(raw)
      const { conversation, duplicated } = await this.store.recordMessage(msg, {
        incrementUnread: msg.direction === 'in'
      })
      if (duplicated) return
      this.broadcast({ type: 'message:new', message: msg, conversation })
      this.ensureAvatar(conversation)
      this.ensureTitle(conversation)
    } catch (err) {
      this.logger.error('入站消息处理失败', err)
    }
  }

  /** 会话还没有头像时异步拉取一次（成功后广播 conversation:updated） */
  private ensureAvatar(conv: { id: string; avatarMediaId?: string }): void {
    if (conv.avatarMediaId || this.avatarAttempted.has(conv.id)) return
    this.avatarAttempted.add(conv.id)
    void (async () => {
      const { channel, accountId, externalChatId } = parseConversationId(conv.id)
      const adapter = this.adapters.get(`${channel}:${accountId}`)
      if (!adapter?.fetchAvatar) return
      try {
        const mediaId = await adapter.fetchAvatar(externalChatId)
        if (!mediaId) return
        const updated = await this.store.patchConversation({ id: conv.id, avatarMediaId: mediaId })
        if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
      } catch (err) {
        this.logger.debug(`拉取头像失败 ${conv.id}`, err)
      }
    })()
  }

  /** 标题仍是原始平台 ID 时，让适配器解析一次真实显示名（群名/备注） */
  private ensureTitle(conv: { id: string; title: string; externalChatId: string }): void {
    if (conv.title !== conv.externalChatId || this.titleAttempted.has(conv.id)) return
    this.titleAttempted.add(conv.id)
    void (async () => {
      const { channel, accountId, externalChatId } = parseConversationId(conv.id)
      const adapter = this.adapters.get(`${channel}:${accountId}`)
      if (!adapter?.fetchTitle) return
      try {
        const title = await adapter.fetchTitle(externalChatId)
        if (!title) return
        const updated = await this.store.patchConversation({ id: conv.id, title })
        if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
      } catch (err) {
        this.logger.debug(`解析会话标题失败 ${conv.id}`, err)
      }
    })()
  }

  private requireAdapter(key: string): ChannelAdapter {
    const adapter = this.adapters.get(key)
    if (!adapter) throw new Error(`未注册的渠道: ${key}`)
    return adapter
  }
}
