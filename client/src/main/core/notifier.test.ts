import { describe, expect, it } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import { bodyKind, preview, truncate } from './notifier'

function msg(body: UnifiedMessage['body']): UnifiedMessage {
  return {
    id: '1',
    conversationId: 'c',
    channel: 'whatsapp',
    accountId: 'main',
    direction: 'in',
    body,
    timestamp: 0,
    status: 'delivered'
  }
}

describe('truncate', () => {
  it('压平换行与连续空白，通知里不能出现多行', () => {
    expect(truncate('hello\n\n  world')).toBe('hello world')
  })
  it('超长截断并加省略号', () => {
    expect(truncate('a'.repeat(80))).toBe(`${'a'.repeat(60)}…`)
  })
  it('刚好等于上限不截断', () => {
    expect(truncate('a'.repeat(60))).toBe('a'.repeat(60))
  })
})

describe('bodyKind', () => {
  it('各类媒体给出类型描述而不是内容', () => {
    expect(bodyKind(msg({ type: 'media', mediaType: 'image' }))).toBe('[图片]')
    expect(bodyKind(msg({ type: 'media', mediaType: 'audio' }))).toBe('[语音]')
    expect(bodyKind(msg({ type: 'media', mediaType: 'document' }))).toBe('[文件]')
  })
  it('文本消息不泄露正文', () => {
    expect(bodyKind(msg({ type: 'text', text: '银行卡号 6222…' }))).toBe('[新消息]')
  })
})

describe('preview', () => {
  it('文本消息显示正文', () => {
    expect(preview(msg({ type: 'text', text: '你好' }))).toBe('你好')
  })
  it('带说明文字的媒体显示说明', () => {
    expect(preview(msg({ type: 'media', mediaType: 'image', caption: '看这个' }))).toBe('看这个')
  })
  it('无说明文字的媒体退回类型描述', () => {
    expect(preview(msg({ type: 'media', mediaType: 'video' }))).toBe('[视频]')
  })
  it('不支持的消息类型不会抛错', () => {
    expect(preview(msg({ type: 'unsupported', description: 'x' }))).toBe('[新消息]')
  })
})
