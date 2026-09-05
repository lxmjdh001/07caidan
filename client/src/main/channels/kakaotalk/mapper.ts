import type { MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'
import type { ChannelDataDocument, ChatlogDocument, LocoId } from '@lukim9-kakao/protocol-android'

const IMAGE_TYPES = new Set([2, 27])
const VIDEO_TYPES = new Set([3])
const AUDIO_TYPES = new Set([5])
const STICKER_TYPES = new Set([6, 12, 20, 25])
const DOCUMENT_TYPES = new Set([4, 18])

export interface KakaoConversationInfo {
  externalChatId: string
  title: string
  isGroup: boolean
  contactId?: string
}

export function locoId(value: LocoId): string {
  return value.toString()
}

export function kakaoTimestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Date.now()
  return value < 10_000_000_000 ? value * 1000 : value
}

export function kakaoConversationInfo(channel: ChannelDataDocument, selfId: string): KakaoConversationInfo {
  const externalChatId = locoId(channel.c)
  const type = channel.t.toLowerCase()
  const isMemo = type === 'memochat'
  const isDirect = type === 'directchat' || type === 'pluschat' || type === 'od'
  const isGroup = !isMemo && !isDirect && (channel.a > 2 || type === 'multichat' || type === 'om')
  const participants = participantPairs(channel)
  const others = participants.filter((participant) => participant.id !== selfId)
  const names = unique((others.length > 0 ? others : participants).map((participant) => participant.name))

  let title: string
  if (isMemo) {
    title = 'KakaoTalk 备忘录'
  } else {
    title = explicitTitle(channel) || summarizedNames(names) || (isGroup ? 'KakaoTalk 群聊' : 'KakaoTalk 联系人')
  }

  const contactId = !isGroup && !isMemo && others.length === 1 && others[0]?.id
    ? `kakao:${others[0].id}`
    : undefined
  return { externalChatId, title, isGroup, contactId }
}

export function mapKakaoChatlog(
  log: ChatlogDocument,
  accountId: string,
  selfId: string,
  authorName?: string
): UnifiedMessage {
  const externalChatId = locoId(log.chatId)
  const externalId = locoId(log.logId)
  const direction = locoId(log.authorId) === selfId ? 'out' : 'in'
  return {
    id: `${accountId}:${externalId}`,
    externalId,
    channel: 'kakaotalk',
    accountId,
    conversationId: conversationId('kakaotalk', accountId, externalChatId),
    direction,
    authorName: direction === 'in' ? authorName : undefined,
    body: kakaoBody(log),
    timestamp: kakaoTimestamp(log.sendAt),
    status: direction === 'out' ? 'sent' : 'delivered'
  }
}

export function kakaoBody(log: ChatlogDocument): MessageBody {
  const type = log.type & 0xffffbfff
  const attachment = parseAttachment(log.attachment)
  const caption = nonEmpty(log.message)

  if (type === 1 || type === 26 || type === 71 || type === 72 || type === 81 || type === 82 || type === 83) {
    return { type: 'text', text: caption ?? messageFromAttachment(attachment) ?? '' }
  }
  if (IMAGE_TYPES.has(type)) {
    return { type: 'media', mediaType: 'image', caption, mimeType: attachmentString(attachment, 'mime', 'mime_type') }
  }
  if (VIDEO_TYPES.has(type)) {
    return {
      type: 'media',
      mediaType: 'video',
      caption,
      mimeType: attachmentString(attachment, 'mime', 'mime_type'),
      durationSec: durationSeconds(attachment)
    }
  }
  if (AUDIO_TYPES.has(type)) {
    return {
      type: 'media',
      mediaType: 'audio',
      caption,
      mimeType: attachmentString(attachment, 'mime', 'mime_type'),
      durationSec: durationSeconds(attachment)
    }
  }
  if (STICKER_TYPES.has(type)) return { type: 'media', mediaType: 'sticker', caption }
  if (DOCUMENT_TYPES.has(type)) {
    return {
      type: 'media',
      mediaType: 'document',
      caption,
      fileName: attachmentString(attachment, 'name', 'filename', 'fileName'),
      mimeType: attachmentString(attachment, 'mime', 'mime_type')
    }
  }
  if (caption) return { type: 'text', text: caption }
  return { type: 'unsupported', description: `kakaotalk-${type}` }
}

function participantPairs(channel: ChannelDataDocument): Array<{ id: string; name: string }> {
  const ids = channel.i ?? []
  const names = channel.k ?? []
  const length = Math.max(ids.length, names.length)
  const result: Array<{ id: string; name: string }> = []
  for (let index = 0; index < length; index += 1) {
    const id = ids[index] === undefined ? '' : String(ids[index])
    const name = nonEmpty(names[index]) ?? ''
    if (id || name) result.push({ id, name })
  }
  return result
}

/** 新版协议若补回显式房名字段，可直接读取；不会依赖任何具体客户账号。 */
function explicitTitle(channel: ChannelDataDocument): string | undefined {
  for (const key of ['name', 'title', 'displayName']) {
    const value = channel[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function summarizedNames(names: string[]): string | undefined {
  if (names.length === 0) return undefined
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} 等 ${names.length} 人`
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function parseAttachment(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function attachmentString(
  attachment: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = attachment?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function messageFromAttachment(attachment: Record<string, unknown> | undefined): string | undefined {
  return attachmentString(attachment, 'text', 'message', 'title')
}

function durationSeconds(attachment: Record<string, unknown> | undefined): number | undefined {
  const value = attachment?.duration ?? attachment?.d
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value > 10_000 ? Math.round(value / 1000) : value
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
