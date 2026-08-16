import { randomUUID } from 'node:crypto'
import type { ChannelState, UnifiedMessage } from '@shared/domain'
import { conversationId, parseConversationId } from '@shared/domain'
import type { OmniEvent } from '@shared/ipc'
import type { TranslationPipeline } from '../translation/pipeline'
import type { ChannelAdapter } from './channel-adapter'
import { noopLogger, type Logger } from './logger'
import type { MessageStore } from './message-store'

/**
 * 渠道管理器：持有所有适配器实例，把它们的事件汇入
 * 翻译管道 → 存储 → 推送给 UI 这条统一链路，并把 UI 的发送请求路由回对应适配器。
 */
export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly states = new Map<string, ChannelState>()

  constructor(
    private readonly store: MessageStore,
    private readonly translation: TranslationPipeline,
    private readonly broadcast: (evt: OmniEvent) => void,
    private readonly logger: Logger = noopLogger
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
    })

    adapter.on('message', (msg) => {
      void this.handleIncoming(msg)
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

  private async handleIncoming(raw: UnifiedMessage): Promise<void> {
    try {
      const msg = await this.translation.processInbound(raw)
      const { conversation, duplicated } = await this.store.recordMessage(msg, {
        incrementUnread: msg.direction === 'in'
      })
      if (duplicated) return
      this.broadcast({ type: 'message:new', message: msg, conversation })
    } catch (err) {
      this.logger.error('入站消息处理失败', err)
    }
  }

  private requireAdapter(key: string): ChannelAdapter {
    const adapter = this.adapters.get(key)
    if (!adapter) throw new Error(`未注册的渠道: ${key}`)
    return adapter
  }
}
