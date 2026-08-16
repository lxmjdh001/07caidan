import { randomUUID } from 'node:crypto'
import type { MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'

/**
 * Baileys 原始消息 → UnifiedMessage 的纯函数映射层。
 * 只依赖结构（不 import baileys 类型），保证可单测、且协议库升级时影响面收敛在此。
 */

export interface WaRawKey {
  remoteJid?: string | null
  fromMe?: boolean | null
  id?: string | null
  participant?: string | null
}

export interface WaRawMessage {
  key: WaRawKey
  pushName?: string | null
  messageTimestamp?: number | { toNumber(): number } | bigint | null
  message?: Record<string, unknown> | null
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

export function tsToMillis(
  ts: WaRawMessage['messageTimestamp'],
  fallback: number
): number {
  if (ts == null) return fallback
  if (typeof ts === 'number') return ts * 1000
  if (typeof ts === 'bigint') return Number(ts) * 1000
  if (typeof ts.toNumber === 'function') return ts.toNumber() * 1000
  return fallback
}

/** 包裹类消息（一次性查看、阅后即焚）逐层解包 */
const WRAPPER_KEYS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']

/** 协议/系统类消息，对用户不可见，直接忽略 */
const IGNORED_KEYS = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'reactionMessage',
  'pollUpdateMessage'
])

export function extractBody(message: Record<string, unknown> | null | undefined): MessageBody | null {
  if (!message) return null

  for (const key of WRAPPER_KEYS) {
    const wrapped = message[key] as { message?: Record<string, unknown> } | undefined
    if (wrapped?.message) return extractBody(wrapped.message)
  }

  if (typeof message.conversation === 'string' && message.conversation) {
    return { type: 'text', text: message.conversation }
  }

  const extended = message.extendedTextMessage as { text?: string } | undefined
  if (extended?.text) {
    return { type: 'text', text: extended.text }
  }

  const image = message.imageMessage as { caption?: string } | undefined
  if (image) return { type: 'media', mediaType: 'image', caption: image.caption || undefined }

  const video = message.videoMessage as { caption?: string } | undefined
  if (video) return { type: 'media', mediaType: 'video', caption: video.caption || undefined }

  if (message.audioMessage) return { type: 'media', mediaType: 'audio' }
  if (message.stickerMessage) return { type: 'media', mediaType: 'sticker' }

  const doc = message.documentMessage as { fileName?: string; caption?: string } | undefined
  if (doc) {
    return { type: 'media', mediaType: 'document', caption: doc.caption || doc.fileName || undefined }
  }

  const keys = Object.keys(message).filter((k) => !IGNORED_KEYS.has(k))
  if (keys.length === 0) return null

  return { type: 'unsupported', description: keys[0] ?? 'unknown' }
}

/**
 * 返回 null 表示应忽略（状态广播、协议消息、无会话 ID 等）。
 */
export function mapWaMessage(raw: WaRawMessage, accountId: string): UnifiedMessage | null {
  const jid = raw.key.remoteJid
  if (!jid || jid === 'status@broadcast') return null

  const body = extractBody(raw.message)
  if (!body) return null

  const direction = raw.key.fromMe ? 'out' : 'in'
  return {
    id: randomUUID(),
    externalId: raw.key.id ?? undefined,
    channel: 'whatsapp',
    accountId,
    conversationId: conversationId('whatsapp', accountId, jid),
    direction,
    authorName: direction === 'in' ? raw.pushName ?? undefined : undefined,
    body,
    timestamp: tsToMillis(raw.messageTimestamp, Date.now()),
    // 手机端同步过来的自己发的消息视为已发送
    status: direction === 'out' ? 'sent' : 'delivered'
  }
}
