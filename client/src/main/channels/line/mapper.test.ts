import { describe, expect, it } from 'vitest'
import { extractLineBody, isLineGroup, lineChatId, mapLineEvent, type LineEvent } from './mapper'

describe('lineChatId / isLineGroup', () => {
  it('群 > 房间 > 用户 优先级', () => {
    expect(lineChatId({ type: 'group', groupId: 'G1', userId: 'U1' })).toBe('G1')
    expect(lineChatId({ type: 'room', roomId: 'R1', userId: 'U1' })).toBe('R1')
    expect(lineChatId({ type: 'user', userId: 'U1' })).toBe('U1')
  })
  it('群/房间算群聊', () => {
    expect(isLineGroup({ type: 'group' })).toBe(true)
    expect(isLineGroup({ type: 'room' })).toBe(true)
    expect(isLineGroup({ type: 'user' })).toBe(false)
  })
})

describe('extractLineBody', () => {
  it('文本不需拉取', () => {
    expect(extractLineBody({ id: '1', type: 'text', text: 'hi' })).toEqual({
      body: { type: 'text', text: 'hi' },
      needFetch: false
    })
  })
  it('图片/视频/语音/文件需拉取', () => {
    expect(extractLineBody({ id: '1', type: 'image' }).needFetch).toBe(true)
    expect(extractLineBody({ id: '1', type: 'audio', duration: 5000 })).toMatchObject({
      body: { type: 'media', mediaType: 'audio', durationSec: 5000 },
      needFetch: true
    })
    expect(extractLineBody({ id: '1', type: 'file', fileName: 'a.pdf' }).body).toMatchObject({
      mediaType: 'document',
      fileName: 'a.pdf'
    })
  })
  it('贴纸不需拉取', () => {
    expect(extractLineBody({ id: '1', type: 'sticker' }).needFetch).toBe(false)
  })
})

describe('mapLineEvent', () => {
  const ev = (o: Partial<LineEvent> = {}): LineEvent => ({
    type: 'message',
    timestamp: 1700000000000,
    source: { type: 'user', userId: 'U1' },
    message: { id: 'M1', type: 'text', text: 'hi' },
    ...o
  })

  it('文本消息映射为入站', () => {
    const r = mapLineEvent(ev({ senderName: '田中' }), 'line1')
    expect(r?.message).toMatchObject({
      channel: 'line',
      accountId: 'line1',
      conversationId: 'line:line1:U1',
      direction: 'in',
      authorName: '田中',
      externalId: 'M1'
    })
    expect(r?.messageId).toBeUndefined()
  })
  it('图片消息返回 messageId 以便拉取', () => {
    const r = mapLineEvent(ev({ message: { id: 'M2', type: 'image' } }), 'line1')
    expect(r?.messageId).toBe('M2')
  })
  it('非消息事件忽略', () => {
    expect(mapLineEvent(ev({ type: 'follow', message: undefined }), 'line1')).toBeNull()
  })
})
