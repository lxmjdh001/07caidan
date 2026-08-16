import { randomUUID } from 'node:crypto'
import type { MediaType, MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'

/**
 * Telegram 普通账号（MTProto）消息 → UnifiedMessage 的纯函数映射。
 *
 * 输入是结构化的中间形态（由适配器从 GramJS 对象抽取），
 * 这样 mapper 不依赖 SDK，可独立单测；GramJS 升级时影响面收敛在适配器。
 */

/** 会话对端类型：私聊 / 普通群 / 超级群或频道 */
export type TgPeerType = 'user' | 'chat' | 'channel'

export interface TgPeer {
  type: TgPeerType
  /** 私聊为对方 user id；群/频道为群 id（均为十进制字符串） */
  id: string
}

export interface TgRawMedia {
  kind: MediaType | 'other'
  mimeType?: string
  fileName?: string
  durationSec?: number
}

export interface TgRawMessage {
  /** 平台消息 id */
  id: number
  /** 文本或媒体说明文字 */
  text: string
  /** unix 秒 */
  date: number
  /** 是否为本账号发出 */
  out: boolean
  peer: TgPeer
  /** 群聊里用于展示发言人 */
  senderName?: string
  media?: TgRawMedia
}

/** 私聊才有自然人身份；群/频道无 */
export function isPrivatePeer(peer: TgPeer): boolean {
  return peer.type === 'user'
}

/** 会话在本系统内的外部 id：私聊用 user id，群加 g 前缀避免与私聊撞号 */
export function peerToChatId(peer: TgPeer): string {
  return peer.type === 'user' ? peer.id : `g${peer.id}`
}

/** 从会话外部 id 反解出客户唯一标识；群聊返回 undefined */
export function chatIdToContactId(externalChatId: string): string | undefined {
  if (externalChatId.startsWith('g')) return undefined
  return `tg:${externalChatId}`
}

export function extractTgUserBody(m: TgRawMessage): MessageBody {
  if (m.media) {
    const kind: MediaType = m.media.kind === 'other' ? 'document' : m.media.kind
    return {
      type: 'media',
      mediaType: kind,
      caption: m.text || undefined,
      mimeType: m.media.mimeType,
      fileName: m.media.fileName,
      durationSec: m.media.durationSec
    }
  }
  if (m.text) return { type: 'text', text: m.text }
  return { type: 'unsupported', description: 'telegram-empty' }
}

/**
 * 映射一条普通账号消息。返回 null 表示应忽略。
 * out=true 的消息是本账号（在手机端或本客户端）发出的，同样入库以保持对话完整。
 */
export function mapTgUserMessage(m: TgRawMessage, accountId: string): UnifiedMessage | null {
  if (!m.peer?.id) return null
  const body = extractTgUserBody(m)
  const direction = m.out ? 'out' : 'in'
  const externalChatId = peerToChatId(m.peer)
  return {
    id: randomUUID(),
    externalId: String(m.id),
    channel: 'telegram',
    accountId,
    conversationId: conversationId('telegram', accountId, externalChatId),
    direction,
    authorName: direction === 'in' ? m.senderName : undefined,
    body,
    timestamp: m.date * 1000,
    status: direction === 'out' ? 'sent' : 'delivered'
  }
}
