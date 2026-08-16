import type { ChannelKind, ChannelState, UnifiedMessage } from '@shared/domain'
import { channelKey } from '@shared/domain'
import { TypedEmitter } from './typed-emitter'

/** 适配器上报的会话元信息（标题等），由 ChannelManager 合并进存储 */
export interface ConversationUpsert {
  externalChatId: string
  title?: string
  isGroup: boolean
}

export interface OutboundResult {
  externalId?: string
}

export interface AdapterEvents extends Record<string, unknown[]> {
  /** 收到新消息（含本账号在手机端发出的消息） */
  message: [UnifiedMessage]
  /** 会话元信息更新 */
  conversation: [ConversationUpsert]
  /** 渠道连接状态变化 */
  state: [ChannelState]
}

/**
 * 渠道适配器基类。每个平台（WhatsApp / Telegram / LINE）实现一个子类，
 * 负责：连接维护、平台消息 ↔ UnifiedMessage 的转换、发送。
 * 适配器之上的所有代码（管理器、存储、UI）不感知任何平台细节。
 */
export abstract class ChannelAdapter extends TypedEmitter<AdapterEvents> {
  abstract readonly kind: ChannelKind
  abstract readonly accountId: string

  get key(): string {
    return channelKey(this.kind, this.accountId)
  }

  /** 建立连接（未登录时应触发 waiting_qr 等状态事件） */
  abstract start(): Promise<void>
  /** 断开连接但保留登录凭证 */
  abstract stop(): Promise<void>
  /** 退出登录并清除凭证 */
  abstract logout(): Promise<void>
  /** 发送文本消息 */
  abstract sendText(externalChatId: string, text: string): Promise<OutboundResult>

  protected makeState(partial: Omit<ChannelState, 'kind' | 'accountId'>): ChannelState {
    return { kind: this.kind, accountId: this.accountId, ...partial }
  }
}
