import { conversationId, previewOf, type MessageBody, type UnifiedMessage } from '@shared/domain'

export interface XAccountSummary {
  userId: string
}

export interface XMediaInput {
  mediaKey?: string
  type?: string
  url?: string
  previewImageUrl?: string
  mimeType?: string
}

export interface XMessageInput {
  id?: string
  event_type?: string
  text?: string
  sender_id?: string
  dm_conversation_id?: string
  created_at?: string | number
  participant_ids?: string[]
  attachments?: { media_keys?: string[] }
  _media?: XMediaInput[]
}

export interface XMappedMessage {
  message: UnifiedMessage
  mediaUrl?: string
}

export function mapXMessage(
  input: XMessageInput,
  accountId: string,
  externalChatId: string,
  account: XAccountSummary
): XMappedMessage {
  const eventId = input.id || fallbackId(externalChatId, input)
  const media = input._media?.find((item) => item.url || item.previewImageUrl)
  const mapped = bodyOf(input, media)
  return {
    message: {
      id: `${accountId}:${eventId}`,
      externalId: eventId,
      channel: 'x',
      accountId,
      conversationId: conversationId('x', accountId, externalChatId),
      direction: input.sender_id === account.userId ? 'out' : 'in',
      body: mapped.body,
      timestamp: timestamp(input.created_at),
      status: 'delivered'
    },
    mediaUrl: mapped.mediaUrl
  }
}

export function previewXMessage(input: XMessageInput | undefined): string | undefined {
  if (!input) return undefined
  return previewOf(bodyOf(input, input._media?.[0]).body)
}

function bodyOf(input: XMessageInput, media?: XMediaInput): { body: MessageBody; mediaUrl?: string } {
  if (media) {
    const type = String(media.type || '').toLowerCase()
    const url = media.url || media.previewImageUrl
    const mediaType = type === 'video' || type === 'animated_gif' ? 'video' : 'image'
    return {
      body: {
        type: 'media',
        mediaType,
        caption: input.text || undefined,
        mimeType: media.mimeType || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg')
      },
      mediaUrl: url
    }
  }
  if (typeof input.text === 'string') return { body: { type: 'text', text: input.text } }
  return { body: { type: 'unsupported', description: 'X 不支持的私信类型' } }
}

function fallbackId(externalChatId: string, input: XMessageInput): string {
  return `x-${externalChatId}-${timestamp(input.created_at)}-${simpleHash(input.text || '')}`
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function timestamp(value: unknown): number {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}
