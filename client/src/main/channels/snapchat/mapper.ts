import { conversationId, type UnifiedMessage } from '@shared/domain'

export interface SnapchatMessageInput {
  id?: string
  message_id?: string
  type?: string
  text?: string
  text_message?: string | { text?: string }
  _id?: string
  _direction?: 'in' | 'out'
  _text?: string
  _timestamp?: number
  created_at?: string | number
}

export function mapSnapchatMessage(
  input: SnapchatMessageInput,
  accountId: string,
  externalChatId: string
): UnifiedMessage {
  const text = input._text || textValue(input.text_message) || input.text || ''
  const externalId = input._id || input.message_id || input.id ||
    `snap-${externalChatId}-${timestamp(input._timestamp || input.created_at)}-${simpleHash(text)}`
  return {
    id: `${accountId}:${externalId}`,
    externalId,
    channel: 'snapchat',
    accountId,
    conversationId: conversationId('snapchat', accountId, externalChatId),
    direction: input._direction === 'out' ? 'out' : 'in',
    body: text
      ? { type: 'text', text }
      : { type: 'unsupported', description: 'Snapchat 不支持的消息类型' },
    timestamp: timestamp(input._timestamp || input.created_at),
    status: 'delivered'
  }
}

export function previewSnapchatMessage(input: SnapchatMessageInput | undefined): string | undefined {
  if (!input) return undefined
  return input._text || textValue(input.text_message) || input.text || '[不支持的消息]'
}

function textValue(value: SnapchatMessageInput['text_message']): string | undefined {
  if (typeof value === 'string') return value
  return value && typeof value.text === 'string' ? value.text : undefined
}

function timestamp(value: unknown): number {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
