import { describe, expect, it } from 'vitest'
import {
  chatIdToContactId,
  extractTgUserBody,
  isPrivatePeer,
  mapTgUserMessage,
  peerToChatId,
  type TgRawMessage
} from './mapper'

const userPeer = { type: 'user' as const, id: '555' }

function msg(o: Partial<TgRawMessage> = {}): TgRawMessage {
  return { id: 1, text: 'hi', date: 1700000000, out: false, peer: userPeer, ...o }
}

describe('peer 处理', () => {
  it('私聊用 user id，群加 g 前缀避免与私聊撞号', () => {
    expect(peerToChatId(userPeer)).toBe('555')
    expect(peerToChatId({ type: 'chat', id: '777' })).toBe('g777')
    expect(peerToChatId({ type: 'channel', id: '888' })).toBe('g888')
  })

  it('只有私聊算自然人', () => {
    expect(isPrivatePeer(userPeer)).toBe(true)
    expect(isPrivatePeer({ type: 'chat', id: '1' })).toBe(false)
  })

  it('客户标识：私聊得 tg:<id>，群聊无身份', () => {
    expect(chatIdToContactId('555')).toBe('tg:555')
    expect(chatIdToContactId('g777')).toBeUndefined()
  })
})

describe('extractTgUserBody', () => {
  it('纯文本', () => {
    expect(extractTgUserBody(msg({ text: 'hello' }))).toEqual({ type: 'text', text: 'hello' })
  })

  it('媒体带说明文字与时长', () => {
    const body = extractTgUserBody(
      msg({ text: '看图', media: { kind: 'image', mimeType: 'image/jpeg' } })
    )
    expect(body).toEqual({
      type: 'media',
      mediaType: 'image',
      caption: '看图',
      mimeType: 'image/jpeg',
      fileName: undefined,
      durationSec: undefined
    })
  })

  it('语音保留时长', () => {
    const body = extractTgUserBody(
      msg({ text: '', media: { kind: 'audio', durationSec: 8, mimeType: 'audio/ogg' } })
    )
    expect(body).toMatchObject({ type: 'media', mediaType: 'audio', durationSec: 8 })
  })

  it('未知媒体类型归为文件', () => {
    expect(extractTgUserBody(msg({ text: '', media: { kind: 'other' } }))).toMatchObject({
      mediaType: 'document'
    })
  })

  it('空消息标记为不支持', () => {
    expect(extractTgUserBody(msg({ text: '' }))).toEqual({
      type: 'unsupported',
      description: 'telegram-empty'
    })
  })
})

describe('mapTgUserMessage', () => {
  it('对方发来 → 入站，带发言人名，时间换算为毫秒', () => {
    const m = mapTgUserMessage(msg({ senderName: '小王' }), 'tg1')
    expect(m).toMatchObject({
      channel: 'telegram',
      accountId: 'tg1',
      conversationId: 'telegram:tg1:555',
      direction: 'in',
      authorName: '小王',
      externalId: '1',
      timestamp: 1700000000000,
      status: 'delivered'
    })
  })

  it('本账号发出 → 出站且不带发言人名', () => {
    const m = mapTgUserMessage(msg({ out: true, senderName: '我' }), 'tg1')
    expect(m?.direction).toBe('out')
    expect(m?.authorName).toBeUndefined()
    expect(m?.status).toBe('sent')
  })

  it('群聊会话 id 带 g 前缀', () => {
    const m = mapTgUserMessage(msg({ peer: { type: 'channel', id: '999' } }), 'tg1')
    expect(m?.conversationId).toBe('telegram:tg1:g999')
  })

  it('缺少 peer 时忽略', () => {
    expect(mapTgUserMessage(msg({ peer: { type: 'user', id: '' } }), 'tg1')).toBeNull()
  })
})
