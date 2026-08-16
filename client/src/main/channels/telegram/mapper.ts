import { randomUUID } from 'node:crypto'
import type { MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'

/**
 * Telegram Bot API 消息 → UnifiedMessage 的纯函数映射。
 * 只依赖结构，不 import 任何 SDK，保证可单测。
 */

export interface TgChat {
  id: number
  type: string // private | group | supergroup | channel
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  voice?: { file_id: string; duration: number; mime_type?: string }
  audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string }
  video?: { file_id: string; duration: number; mime_type?: string }
  document?: { file_id: string; mime_type?: string; file_name?: string }
  sticker?: { file_id: string }
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

export function chatTitle(chat: TgChat): string {
  if (chat.title) return chat.title
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
  return name || chat.username || String(chat.id)
}

export function isGroupChat(chat: TgChat): boolean {
  return chat.type === 'group' || chat.type === 'supergroup'
}

/** 提取消息体；返回要下载的 file_id（媒体）便于适配器后续拉取 */
export function extractTgBody(m: TgMessage): { body: MessageBody; fileId?: string } {
  if (m.text) return { body: { type: 'text', text: m.text } }

  if (m.photo && m.photo.length > 0) {
    // 取最大尺寸
    const largest = m.photo.reduce((a, b) => (b.width > a.width ? b : a))
    return {
      body: { type: 'media', mediaType: 'image', caption: m.caption || undefined },
      fileId: largest.file_id
    }
  }
  if (m.voice) {
    return {
      body: { type: 'media', mediaType: 'audio', mimeType: m.voice.mime_type, durationSec: m.voice.duration },
      fileId: m.voice.file_id
    }
  }
  if (m.audio) {
    return {
      body: {
        type: 'media',
        mediaType: 'audio',
        mimeType: m.audio.mime_type,
        fileName: m.audio.file_name,
        durationSec: m.audio.duration
      },
      fileId: m.audio.file_id
    }
  }
  if (m.video) {
    return {
      body: { type: 'media', mediaType: 'video', caption: m.caption || undefined, mimeType: m.video.mime_type, durationSec: m.video.duration },
      fileId: m.video.file_id
    }
  }
  if (m.sticker) {
    return { body: { type: 'media', mediaType: 'sticker' }, fileId: m.sticker.file_id }
  }
  if (m.document) {
    return {
      body: {
        type: 'media',
        mediaType: 'document',
        caption: m.caption || m.document.file_name || undefined,
        fileName: m.document.file_name,
        mimeType: m.document.mime_type
      },
      fileId: m.document.file_id
    }
  }
  return { body: { type: 'unsupported', description: 'telegram-message' } }
}

/**
 * 映射一条 Telegram 消息。selfId 为 bot 自身 id（判断 direction）。
 * 返回 { message, fileId }，fileId 非空表示需下载媒体。
 */
export function mapTgMessage(
  m: TgMessage,
  accountId: string,
  selfId: number
): { message: UnifiedMessage; fileId?: string } | null {
  if (!m.chat) return null
  const { body, fileId } = extractTgBody(m)
  const direction = m.from?.id === selfId ? 'out' : 'in'
  const authorName =
    direction === 'in' && m.from
      ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username
      : undefined
  return {
    message: {
      id: randomUUID(),
      externalId: String(m.message_id),
      channel: 'telegram',
      accountId,
      conversationId: conversationId('telegram', accountId, String(m.chat.id)),
      direction,
      authorName,
      body,
      timestamp: m.date * 1000,
      status: direction === 'out' ? 'sent' : 'delivered'
    },
    fileId
  }
}
