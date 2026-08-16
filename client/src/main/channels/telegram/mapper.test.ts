import { describe, expect, it } from 'vitest'
import { chatTitle, extractTgBody, isGroupChat, mapTgMessage, type TgMessage } from './mapper'

const chat = { id: 111, type: 'private', first_name: '小王' }

function msg(o: Partial<TgMessage> = {}): TgMessage {
  return { message_id: 1, from: { id: 999, first_name: '小王' }, chat, date: 1700000000, ...o }
}

describe('chatTitle / isGroupChat', () => {
  it('私聊用名字，群用群名', () => {
    expect(chatTitle({ id: 1, type: 'private', first_name: '张', last_name: '三' })).toBe('张 三')
    expect(chatTitle({ id: 2, type: 'group', title: '客服群' })).toBe('客服群')
    expect(chatTitle({ id: 3, type: 'private', username: 'bob' })).toBe('bob')
  })
  it('区分群聊', () => {
    expect(isGroupChat({ id: 1, type: 'supergroup' })).toBe(true)
    expect(isGroupChat({ id: 1, type: 'private' })).toBe(false)
  })
})

describe('extractTgBody', () => {
  it('文本', () => {
    expect(extractTgBody(msg({ text: 'hi' })).body).toEqual({ type: 'text', text: 'hi' })
  })
  it('图片取最大尺寸并带 caption 与 fileId', () => {
    const r = extractTgBody(
      msg({
        caption: '看图',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 100, height: 100 },
          { file_id: 'big', file_unique_id: 'b', width: 800, height: 600 }
        ]
      })
    )
    expect(r.fileId).toBe('big')
    expect(r.body).toEqual({ type: 'media', mediaType: 'image', caption: '看图' })
  })
  it('语音带时长', () => {
    const r = extractTgBody(msg({ voice: { file_id: 'v', duration: 8, mime_type: 'audio/ogg' } }))
    expect(r.fileId).toBe('v')
    expect(r.body).toMatchObject({ type: 'media', mediaType: 'audio', durationSec: 8 })
  })
  it('文档带文件名', () => {
    const r = extractTgBody(msg({ document: { file_id: 'd', file_name: 'a.pdf', mime_type: 'application/pdf' } }))
    expect(r.body).toMatchObject({ type: 'media', mediaType: 'document', fileName: 'a.pdf' })
  })
})

describe('mapTgMessage', () => {
  it('别人发的 → 入站，带发信人名', () => {
    const r = mapTgMessage(msg({ text: 'hi', from: { id: 555, first_name: 'A' } }), 'bot1', 999)
    expect(r?.message).toMatchObject({
      channel: 'telegram_bot',
      accountId: 'bot1',
      conversationId: 'telegram_bot:bot1:111',
      direction: 'in',
      authorName: 'A',
      externalId: '1'
    })
  })
  it('bot 自己发的 → 出站', () => {
    const r = mapTgMessage(msg({ text: 'reply', from: { id: 999, first_name: 'bot' } }), 'bot1', 999)
    expect(r?.message.direction).toBe('out')
    expect(r?.message.authorName).toBeUndefined()
  })
  it('时间戳换算为毫秒；图片返回 fileId', () => {
    const r = mapTgMessage(
      msg({ photo: [{ file_id: 'p', file_unique_id: 'u', width: 100, height: 100 }] }),
      'bot1',
      999
    )
    expect(r?.message.timestamp).toBe(1700000000000)
    expect(r?.fileId).toBe('p')
  })
})
