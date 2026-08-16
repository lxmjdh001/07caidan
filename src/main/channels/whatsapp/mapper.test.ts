import { describe, expect, it } from 'vitest'
import { extractBody, isGroupJid, mapWaMessage, tsToMillis, type WaRawMessage } from './mapper'

const baseKey = { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'MSG1' }

function raw(overrides: Partial<WaRawMessage> = {}): WaRawMessage {
  return {
    key: baseKey,
    pushName: 'Alice',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hi' },
    ...overrides
  }
}

describe('extractBody', () => {
  it('conversation → 文本', () => {
    expect(extractBody({ conversation: 'hello' })).toEqual({ type: 'text', text: 'hello' })
  })

  it('extendedTextMessage → 文本', () => {
    expect(extractBody({ extendedTextMessage: { text: 'linked' } })).toEqual({
      type: 'text',
      text: 'linked'
    })
  })

  it('图片/视频保留 caption', () => {
    expect(extractBody({ imageMessage: { caption: 'pic' } })).toEqual({
      type: 'media',
      mediaType: 'image',
      caption: 'pic'
    })
    expect(extractBody({ videoMessage: {} })).toEqual({
      type: 'media',
      mediaType: 'video',
      caption: undefined
    })
  })

  it('文档用 fileName 兜底 caption', () => {
    expect(extractBody({ documentMessage: { fileName: 'a.pdf' } })).toEqual({
      type: 'media',
      mediaType: 'document',
      caption: 'a.pdf'
    })
  })

  it('语音与贴纸', () => {
    expect(extractBody({ audioMessage: {} })).toEqual({ type: 'media', mediaType: 'audio' })
    expect(extractBody({ stickerMessage: {} })).toEqual({ type: 'media', mediaType: 'sticker' })
  })

  it('阅后即焚/一次性查看逐层解包', () => {
    expect(
      extractBody({ ephemeralMessage: { message: { conversation: 'secret' } } })
    ).toEqual({ type: 'text', text: 'secret' })
    expect(
      extractBody({ viewOnceMessageV2: { message: { imageMessage: {} } } })
    ).toEqual({ type: 'media', mediaType: 'image', caption: undefined })
  })

  it('协议类消息返回 null（忽略）', () => {
    expect(extractBody({ protocolMessage: {} })).toBeNull()
    expect(extractBody({ reactionMessage: {} })).toBeNull()
    expect(extractBody(null)).toBeNull()
    expect(extractBody(undefined)).toBeNull()
  })

  it('未知类型 → unsupported 并带类型名', () => {
    expect(extractBody({ pollCreationMessage: {} })).toEqual({
      type: 'unsupported',
      description: 'pollCreationMessage'
    })
  })
})

describe('mapWaMessage', () => {
  it('入站文本消息完整映射', () => {
    const msg = mapWaMessage(raw(), 'main')
    expect(msg).toMatchObject({
      externalId: 'MSG1',
      channel: 'whatsapp',
      accountId: 'main',
      conversationId: 'whatsapp:main:123@s.whatsapp.net',
      direction: 'in',
      authorName: 'Alice',
      body: { type: 'text', text: 'hi' },
      timestamp: 1_700_000_000_000,
      status: 'delivered'
    })
    expect(msg?.id).toBeTruthy()
  })

  it('fromMe → 出站，且不带 authorName', () => {
    const msg = mapWaMessage(raw({ key: { ...baseKey, fromMe: true } }), 'main')
    expect(msg?.direction).toBe('out')
    expect(msg?.authorName).toBeUndefined()
    expect(msg?.status).toBe('sent')
  })

  it('状态广播忽略', () => {
    expect(mapWaMessage(raw({ key: { ...baseKey, remoteJid: 'status@broadcast' } }), 'main')).toBeNull()
  })

  it('无 remoteJid 或无内容体忽略', () => {
    expect(mapWaMessage(raw({ key: { ...baseKey, remoteJid: null } }), 'main')).toBeNull()
    expect(mapWaMessage(raw({ message: { protocolMessage: {} } }), 'main')).toBeNull()
  })
})

describe('tsToMillis', () => {
  it('数字秒 → 毫秒', () => {
    expect(tsToMillis(1_700_000_000, 0)).toBe(1_700_000_000_000)
  })

  it('Long 风格对象与 bigint', () => {
    expect(tsToMillis({ toNumber: () => 1_700_000_001 }, 0)).toBe(1_700_000_001_000)
    expect(tsToMillis(BigInt(1_700_000_002), 0)).toBe(1_700_000_002_000)
  })

  it('空值用 fallback', () => {
    expect(tsToMillis(null, 42)).toBe(42)
    expect(tsToMillis(undefined, 42)).toBe(42)
  })
})

describe('isGroupJid', () => {
  it('区分群聊与私聊', () => {
    expect(isGroupJid('123-456@g.us')).toBe(true)
    expect(isGroupJid('123@s.whatsapp.net')).toBe(false)
  })
})
