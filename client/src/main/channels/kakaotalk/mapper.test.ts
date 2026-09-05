import { Long } from 'bson'
import { describe, expect, it } from 'vitest'
import type { ChannelDataDocument, ChatlogDocument } from '@lukim9-kakao/protocol-android'
import { kakaoBody, kakaoConversationInfo, mapKakaoChatlog } from './mapper'

function log(overrides: Partial<ChatlogDocument> = {}): ChatlogDocument {
  return {
    logId: Long.fromString('9007199254740993'),
    chatId: Long.fromString('8000000000000001'),
    type: 1,
    authorId: Long.fromString('222'),
    message: '안녕하세요',
    sendAt: 1_700_000_000,
    attachment: '{}',
    msgId: 1,
    prevId: Long.ZERO,
    ...overrides
  }
}

function channel(overrides: Partial<ChannelDataDocument> = {}): ChannelDataDocument {
  return {
    c: Long.fromString('8000000000000001'),
    t: 'DirectChat',
    a: 2,
    n: 1,
    s: Long.ZERO,
    ll: Long.ZERO,
    o: 0,
    p: false,
    i: [111, 222],
    k: ['我', '김민수'],
    ...overrides
  }
}

describe('KakaoTalk mapper', () => {
  it('保留 64 位消息 ID 并识别方向', () => {
    const mapped = mapKakaoChatlog(log(), 'ka1', '111', '김민수')
    expect(mapped.externalId).toBe('9007199254740993')
    expect(mapped.conversationId).toBe('kakaotalk:ka1:8000000000000001')
    expect(mapped.direction).toBe('in')
    expect(mapped.authorName).toBe('김민수')
    expect(mapped.timestamp).toBe(1_700_000_000_000)
  })

  it('从协议成员列表读取私聊名称与稳定客户标识', () => {
    expect(kakaoConversationInfo(channel(), '111')).toEqual({
      externalChatId: '8000000000000001',
      title: '김민수',
      isGroup: false,
      contactId: 'kakao:222'
    })
  })

  it('识别备忘录与群聊', () => {
    expect(kakaoConversationInfo(channel({ t: 'MemoChat', a: 1, i: [111], k: ['我'] }), '111').title)
      .toBe('KakaoTalk 备忘录')
    const group = kakaoConversationInfo(channel({ t: 'MultiChat', a: 4, i: [111, 2, 3, 4], k: ['我', 'A', 'B', 'C'] }), '111')
    expect(group).toMatchObject({ title: 'A, B, C', isGroup: true, contactId: undefined })
  })

  it('映射媒体元数据且容忍损坏 attachment', () => {
    expect(kakaoBody(log({ type: 18, message: '资料', attachment: '{"name":"报价.pdf","mime":"application/pdf"}' })))
      .toEqual({ type: 'media', mediaType: 'document', caption: '资料', fileName: '报价.pdf', mimeType: 'application/pdf' })
    expect(kakaoBody(log({ type: 20, message: undefined, attachment: '{bad' })))
      .toEqual({ type: 'media', mediaType: 'sticker', caption: undefined })
  })
})
