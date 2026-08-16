import { randomUUID } from 'node:crypto'
import type { MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'

/**
 * LINE Webhook 事件 → UnifiedMessage 的纯函数映射。
 * LINE 只有 message 事件里的 message 携带内容；媒体需二次拉取（返回 messageId）。
 */

export interface LineSource {
  type: string // user | group | room
  userId?: string
  groupId?: string
  roomId?: string
}

export interface LineMessageContent {
  id: string
  type: string // text | image | video | audio | file | sticker | location
  text?: string
  fileName?: string
  duration?: number
}

export interface LineEvent {
  type: string // message | follow | ...
  timestamp: number
  source: LineSource
  message?: LineMessageContent
  /** 客户端从 webhook 收到时可附带发信人显示名（server 已代查 profile） */
  senderName?: string
}

/** LINE 会话标识：group > room > user */
export function lineChatId(src: LineSource): string {
  return src.groupId || src.roomId || src.userId || 'unknown'
}

export function isLineGroup(src: LineSource): boolean {
  return src.type === 'group' || src.type === 'room'
}

export function extractLineBody(msg: LineMessageContent): { body: MessageBody; needFetch: boolean } {
  switch (msg.type) {
    case 'text':
      return { body: { type: 'text', text: msg.text ?? '' }, needFetch: false }
    case 'image':
      return { body: { type: 'media', mediaType: 'image' }, needFetch: true }
    case 'video':
      return { body: { type: 'media', mediaType: 'video', durationSec: msg.duration }, needFetch: true }
    case 'audio':
      return { body: { type: 'media', mediaType: 'audio', durationSec: msg.duration }, needFetch: true }
    case 'file':
      return { body: { type: 'media', mediaType: 'document', fileName: msg.fileName }, needFetch: true }
    case 'sticker':
      return { body: { type: 'media', mediaType: 'sticker' }, needFetch: false }
    default:
      return { body: { type: 'unsupported', description: `line-${msg.type}` }, needFetch: false }
  }
}

/** 映射一条 LINE 事件；非消息事件或无内容返回 null。needFetch 表示要拉媒体。 */
export function mapLineEvent(
  ev: LineEvent,
  accountId: string
): { message: UnifiedMessage; messageId?: string } | null {
  if (ev.type !== 'message' || !ev.message) return null
  const { body, needFetch } = extractLineBody(ev.message)
  const chatId = lineChatId(ev.source)
  return {
    message: {
      id: randomUUID(),
      externalId: ev.message.id,
      channel: 'line',
      accountId,
      conversationId: conversationId('line', accountId, chatId),
      // LINE Webhook 只推送用户发来的消息（自己回复不会回推）
      direction: 'in',
      authorName: ev.senderName,
      body,
      timestamp: ev.timestamp,
      status: 'delivered'
    },
    messageId: needFetch ? ev.message.id : undefined
  }
}
