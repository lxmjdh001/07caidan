import type { MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId, previewOf } from '@shared/domain'
import type { ConversationUpsert } from '../../core/channel-adapter'

export interface TikTokAccountSummary {
  businessId: string
}

export interface TikTokParticipantInput {
  role?: string
  id?: string
  display_name?: string
  profile_image?: string
}

export interface TikTokMessageInput {
  message_id?: string
  conversation_id?: string
  /** Webhook 使用 from/to，历史 REST 使用 sender/recipient。 */
  from?: string
  to?: string
  sender?: string
  recipient?: string
  timestamp?: number
  message_type?: string
  type?: string
  unique_identifier?: string
  from_user?: { role?: string; id?: string }
  to_user?: { role?: string; id?: string }
  text?: { body?: string }
  image?: { media_id?: string }
  video?: { media_id?: string }
  sticker?: { url?: string }
  emoji?: { url?: string }
  share_post?: { embed_url?: string; video_id?: string }
  template?: { type?: string; title?: string; elements?: unknown[]; buttons?: unknown[] }
}

export interface TikTokWebhookEnvelope {
  event?: string
  user_openid?: string
  create_time?: number
  content?: string | TikTokMessageInput
}

export type TikTokMediaReference =
  | {
      kind: 'api'
      conversationId: string
      messageId: string
      mediaId: string
      mediaType: 'IMAGE' | 'VIDEO'
    }
  | { kind: 'url'; url: string }

export interface TikTokMappedEvent {
  message: UnifiedMessage
  conversation: ConversationUpsert
  media?: TikTokMediaReference
  profile?: {
    name?: string
    username?: string
    contactId?: string
  }
}

export type TikTokWebhookMapResult = TikTokMappedEvent | { needsHistoryRefresh: true }

export function mapTikTokWebhook(
  envelope: TikTokWebhookEnvelope,
  accountId: string,
  account: TikTokAccountSummary
): TikTokWebhookMapResult | undefined {
  if (envelope.event === 'im_receive_msg_eu') return { needsHistoryRefresh: true }
  if (envelope.event !== 'im_receive_msg' && envelope.event !== 'im_send_msg') return undefined
  const input = parseContent(envelope.content)
  if (!input) return undefined
  const externalChatId = input.conversation_id || ''
  if (!externalChatId) return undefined
  const outbound = envelope.event === 'im_send_msg' || isBusiness(input.from_user, account.businessId)
  const messageId = input.message_id || `tiktok:${externalChatId}:${finiteTimestamp(input.timestamp || envelope.create_time)}`
  const mappedBody = bodyAndMedia(input, externalChatId, messageId)
  const username = outbound ? (input.to || input.recipient) : (input.from || input.sender)
  const personalId = input.unique_identifier || personalUserId(input)
  const title = username || personalId
  const contactId = personalId ? `tiktok:${account.businessId}:${personalId}` : undefined
  const publicId = username ? `@${username.replace(/^@/, '')}` : undefined
  return {
    message: {
      id: `${accountId}:${messageId}`,
      externalId: messageId,
      channel: 'tiktok',
      accountId,
      conversationId: conversationId('tiktok', accountId, externalChatId),
      direction: outbound ? 'out' : 'in',
      authorName: outbound ? undefined : username,
      body: mappedBody.body,
      timestamp: finiteTimestamp(input.timestamp || envelope.create_time),
      status: 'delivered'
    },
    conversation: {
      externalChatId,
      title,
      publicId,
      contactId,
      isGroup: false,
      lastMessageAt: finiteTimestamp(input.timestamp || envelope.create_time),
      lastMessagePreview: previewOf(mappedBody.body)
    },
    media: mappedBody.media,
    profile: { name: title, username, contactId }
  }
}

export function mapTikTokHistoryMessage(
  input: TikTokMessageInput,
  accountId: string,
  externalChatId: string,
  account: TikTokAccountSummary
): { message: UnifiedMessage; media?: TikTokMediaReference } {
  const messageId = input.message_id || `tiktok:${externalChatId}:${finiteTimestamp(input.timestamp)}`
  const mappedBody = bodyAndMedia(input, externalChatId, messageId)
  return {
    message: {
      id: `${accountId}:${messageId}`,
      externalId: messageId,
      channel: 'tiktok',
      accountId,
      conversationId: conversationId('tiktok', accountId, externalChatId),
      direction: isBusiness(input.from_user, account.businessId) ? 'out' : 'in',
      authorName: input.sender,
      body: mappedBody.body,
      timestamp: finiteTimestamp(input.timestamp),
      status: 'delivered'
    },
    media: mappedBody.media
  }
}

function bodyAndMedia(
  input: TikTokMessageInput,
  conversationIdValue: string,
  messageId: string
): { body: MessageBody; media?: TikTokMediaReference } {
  const type = String(input.message_type || input.type || '').toUpperCase()
  if (type === 'TEXT' && typeof input.text?.body === 'string') {
    return { body: { type: 'text', text: input.text.body } }
  }
  if (type === 'IMAGE' && input.image?.media_id) {
    return {
      body: { type: 'media', mediaType: 'image', mimeType: 'image/jpeg' },
      media: {
        kind: 'api',
        conversationId: conversationIdValue,
        messageId,
        mediaId: input.image.media_id,
        mediaType: 'IMAGE'
      }
    }
  }
  if (type === 'VIDEO' && input.video?.media_id) {
    return {
      body: { type: 'media', mediaType: 'video', mimeType: 'video/mp4' },
      media: {
        kind: 'api',
        conversationId: conversationIdValue,
        messageId,
        mediaId: input.video.media_id,
        mediaType: 'VIDEO'
      }
    }
  }
  if (type === 'STICKER' && input.sticker?.url) {
    return {
      body: { type: 'media', mediaType: 'sticker', mimeType: 'image/webp' },
      media: { kind: 'url', url: input.sticker.url }
    }
  }
  if (type === 'EMOJI' && input.emoji?.url) {
    return {
      body: { type: 'media', mediaType: 'image' },
      media: { kind: 'url', url: input.emoji.url }
    }
  }
  if (type === 'SHARE_POST') {
    const url = input.share_post?.embed_url
    return { body: { type: 'text', text: url ? `[TikTok 帖子] ${url}` : '[TikTok 帖子]' } }
  }
  if (type === 'TEMPLATE') {
    return { body: { type: 'text', text: input.template?.title || '[TikTok 互动卡片]' } }
  }
  return { body: { type: 'unsupported', description: `TikTok 暂不支持的消息类型：${type || 'OTHER'}` } }
}

function parseContent(value: TikTokWebhookEnvelope['content']): TikTokMessageInput | undefined {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as TikTokMessageInput
        : undefined
    } catch {
      return undefined
    }
  }
  return value && typeof value === 'object' ? value : undefined
}

function isBusiness(user: TikTokMessageInput['from_user'], businessId: string): boolean {
  return String(user?.role || '').toLowerCase() === 'business_account' || user?.id === businessId
}

function personalUserId(input: TikTokMessageInput): string | undefined {
  for (const user of [input.from_user, input.to_user]) {
    if (String(user?.role || '').toLowerCase() === 'personal_account' && user?.id) return user.id
  }
  return undefined
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value)
  // Webhook create_time may be seconds while message timestamp is milliseconds.
  if (!Number.isFinite(number) || number <= 0) return Date.now()
  return number < 10_000_000_000 ? number * 1000 : number
}
