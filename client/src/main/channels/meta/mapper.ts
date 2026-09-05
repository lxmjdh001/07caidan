import type { ChannelKind, MediaType, MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId, previewOf } from '@shared/domain'
import type { ConversationUpsert } from '../../core/channel-adapter'

export type MetaChannel = Extract<ChannelKind, 'facebook' | 'instagram'>

export interface MetaAccountSummary {
  assetId: string
  pageId: string
}

export interface MetaMappedEvent {
  message: UnifiedMessage
  conversation: ConversationUpsert
  mediaUrl?: string
}

export interface MetaWebhookEnvelope {
  object?: string
  entryId?: string
  event?: {
    sender?: { id?: string }
    recipient?: { id?: string }
    timestamp?: number
    message?: {
      mid?: string
      text?: string
      is_echo?: boolean
      attachments?: Array<{
        type?: string
        name?: string
        payload?: { url?: string; sticker_id?: string | number }
      }>
    }
    postback?: { mid?: string; title?: string; payload?: string }
  }
}

export interface MetaHistoryMessageInput {
  id: string
  createdTime: number
  fromId?: string
  fromName?: string
  toIds: string[]
  text?: string
  attachments: Array<{ type: string; url?: string; name?: string; mimeType?: string }>
}

export function mapMetaWebhook(
  envelope: MetaWebhookEnvelope,
  channel: MetaChannel,
  accountId: string,
  account: MetaAccountSummary
): MetaMappedEvent | undefined {
  const event = envelope.event
  if (!event) return undefined
  const selfIds = new Set([account.assetId, account.pageId, envelope.entryId].filter(Boolean))
  const senderId = event.sender?.id || ''
  const recipientId = event.recipient?.id || ''
  const outbound = Boolean(event.message?.is_echo) || selfIds.has(senderId)
  const externalChatId = outbound ? recipientId : senderId
  if (!externalChatId || selfIds.has(externalChatId)) return undefined

  const attachment = event.message?.attachments?.[0]
  const body = event.message
    ? metaBody(event.message.text, attachment && {
        type: attachment.type || '',
        url: attachment.payload?.url,
        name: attachment.name,
        sticker: Boolean(attachment.payload?.sticker_id)
      })
    : event.postback
      ? { type: 'text' as const, text: event.postback.title || event.postback.payload || '[按钮操作]' }
      : undefined
  if (!body) return undefined

  const timestamp = finiteTimestamp(event.timestamp)
  const externalId = event.message?.mid || event.postback?.mid ||
    `${channel}:${externalChatId}:${timestamp}:${previewOf(body).slice(0, 40)}`
  return {
    message: {
      id: `${accountId}:${externalId}`,
      externalId,
      channel,
      accountId,
      conversationId: conversationId(channel, accountId, externalChatId),
      direction: outbound ? 'out' : 'in',
      body,
      timestamp,
      status: 'delivered'
    },
    conversation: { externalChatId, isGroup: false },
    mediaUrl: attachment?.payload?.url
  }
}

export function mapMetaHistoryMessage(
  input: MetaHistoryMessageInput,
  channel: MetaChannel,
  accountId: string,
  externalChatId: string,
  account: MetaAccountSummary
): { message: UnifiedMessage; mediaUrl?: string } {
  const attachment = input.attachments[0]
  const body = metaBody(input.text, attachment && {
    type: attachment.type,
    url: attachment.url,
    name: attachment.name,
    mimeType: attachment.mimeType
  })
  const selfIds = new Set([account.assetId, account.pageId])
  return {
    message: {
      id: `${accountId}:${input.id}`,
      externalId: input.id,
      channel,
      accountId,
      conversationId: conversationId(channel, accountId, externalChatId),
      direction: input.fromId && selfIds.has(input.fromId) ? 'out' : 'in',
      authorName: input.fromName,
      body,
      timestamp: finiteTimestamp(input.createdTime),
      status: 'delivered'
    },
    mediaUrl: attachment?.url
  }
}

function metaBody(
  text: string | undefined,
  attachment?: { type: string; url?: string; name?: string; mimeType?: string; sticker?: boolean }
): MessageBody {
  if (attachment) {
    const mediaType = attachment.sticker
      ? 'sticker'
      : mediaTypeOf(attachment.type, attachment.mimeType)
    return {
      type: 'media',
      mediaType,
      caption: text || undefined,
      mimeType: attachment.mimeType,
      fileName: attachment.name
    }
  }
  if (typeof text === 'string') return { type: 'text', text }
  return { type: 'unsupported', description: 'Meta 暂不支持的消息类型' }
}

function mediaTypeOf(type: string, mimeType?: string): MediaType {
  const normalized = `${type} ${mimeType || ''}`.toLowerCase()
  if (normalized.includes('image') || normalized.includes('share')) return 'image'
  if (normalized.includes('video')) return 'video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'audio'
  if (normalized.includes('sticker')) return 'sticker'
  return 'document'
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : Date.now()
}
