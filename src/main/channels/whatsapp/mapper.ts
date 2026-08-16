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

interface MediaNode {
  caption?: string
  mimetype?: string
  fileName?: string
  fileLength?: number | string | { toNumber(): number }
  seconds?: number
}

const MEDIA_NODE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage'
]

/** 媒体文件大小（字节），拿不到返回 0 */
export function mediaFileLength(message: Record<string, unknown> | null | undefined): number {
  if (!message) return 0
  for (const key of WRAPPER_KEYS) {
    const wrapped = message[key] as { message?: Record<string, unknown> } | undefined
    if (wrapped?.message) return mediaFileLength(wrapped.message)
  }
  for (const key of MEDIA_NODE_KEYS) {
    const node = message[key] as MediaNode | undefined
    const len = node?.fileLength
    if (len == null) continue
    if (typeof len === 'number') return len
    if (typeof len === 'string') return Number(len) || 0
    if (typeof len.toNumber === 'function') return len.toNumber()
  }
  return 0
}

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

  const image = message.imageMessage as MediaNode | undefined
  if (image) {
    return {
      type: 'media',
      mediaType: 'image',
      caption: image.caption || undefined,
      mimeType: image.mimetype || undefined
    }
  }

  const video = message.videoMessage as MediaNode | undefined
  if (video) {
    return {
      type: 'media',
      mediaType: 'video',
      caption: video.caption || undefined,
      mimeType: video.mimetype || undefined,
      durationSec: typeof video.seconds === 'number' ? video.seconds : undefined
    }
  }

  const audio = message.audioMessage as MediaNode | undefined
  if (audio) {
    return {
      type: 'media',
      mediaType: 'audio',
      mimeType: audio.mimetype || undefined,
      durationSec: typeof audio.seconds === 'number' ? audio.seconds : undefined
    }
  }

  const sticker = message.stickerMessage as MediaNode | undefined
  if (sticker) return { type: 'media', mediaType: 'sticker', mimeType: sticker.mimetype || undefined }

  const doc = message.documentMessage as MediaNode | undefined
  if (doc) {
    return {
      type: 'media',
      mediaType: 'document',
      caption: doc.caption || undefined,
      fileName: doc.fileName || undefined,
      mimeType: doc.mimetype || undefined
    }
  }

  const keys = Object.keys(message).filter((k) => !IGNORED_KEYS.has(k))
  if (keys.length === 0) return null

  return { type: 'unsupported', description: keys[0] ?? 'unknown' }
}

/** Meta AI 等官方机器人身份：participant 以 @bot 结尾 */
export function isBotParticipant(participant: string | null | undefined): boolean {
  return !!participant?.endsWith('@bot')
}

/**
 * 返回 null 表示应忽略（状态广播、协议消息、无会话 ID 等）。
 *
 * Meta AI 特殊处理：WhatsApp 把 AI 对话挂在自己 jid 的会话下，
 * 靠 key.participant（@bot 结尾）区分。这里把 bot 消息拆分到以
 * bot jid 为标识的独立会话，方向记为入站。
 */
export function mapWaMessage(raw: WaRawMessage, accountId: string): UnifiedMessage | null {
  const jid = raw.key.remoteJid
  if (!jid || jid === 'status@broadcast') return null

  const body = extractBody(raw.message)
  if (!body) return null

  const participant = raw.key.participant ?? undefined
  const isBot = isBotParticipant(participant)
  const chatJid = isBot ? participant! : jid
  const direction = isBot ? 'in' : raw.key.fromMe ? 'out' : 'in'

  return {
    id: randomUUID(),
    externalId: raw.key.id ?? undefined,
    channel: 'whatsapp',
    accountId,
    conversationId: conversationId('whatsapp', accountId, chatJid),
    direction,
    authorName: isBot
      ? raw.pushName || 'Meta AI'
      : direction === 'in'
        ? raw.pushName ?? undefined
        : undefined,
    body,
    timestamp: tsToMillis(raw.messageTimestamp, Date.now()),
    // 手机端同步过来的自己发的消息视为已发送
    status: direction === 'out' ? 'sent' : 'delivered'
  }
}
