import { describe, expect, it } from 'vitest'
import {
  extractAdReply,
  extractBody,
  isGroupJid,
  mapWaMessage,
  mediaFileLength,
  tsToMillis,
  type WaRawMessage
} from './mapper'

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

  it('图片/视频保留 caption 与 mimeType', () => {
    expect(extractBody({ imageMessage: { caption: 'pic', mimetype: 'image/jpeg' } })).toEqual({
      type: 'media',
      mediaType: 'image',
      caption: 'pic',
      mimeType: 'image/jpeg'
    })
    expect(extractBody({ videoMessage: {} })).toEqual({
      type: 'media',
      mediaType: 'video',
      caption: undefined,
      mimeType: undefined
    })
  })

  it('文档保留 fileName 与 mimeType', () => {
    expect(
      extractBody({ documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } })
    ).toEqual({
      type: 'media',
      mediaType: 'document',
      caption: undefined,
      fileName: 'a.pdf',
      mimeType: 'application/pdf'
    })
  })

  it('语音与贴纸', () => {
    expect(extractBody({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } })).toEqual({
      type: 'media',
      mediaType: 'audio',
      mimeType: 'audio/ogg; codecs=opus'
    })
    expect(extractBody({ stickerMessage: {} })).toEqual({
      type: 'media',
      mediaType: 'sticker',
      mimeType: undefined
    })
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

describe('Meta AI (bot) 消息', () => {
  it('participant 为 @bot 时拆分到独立会话且方向为入站', () => {
    const msg = mapWaMessage(
      raw({
        key: {
          remoteJid: '37254100094@s.whatsapp.net',
          fromMe: true,
          id: 'BOT1',
          participant: '13135550002@bot'
        },
        pushName: 'Meta AI',
        message: { extendedTextMessage: { text: 'AI 回复' } }
      }),
      'main'
    )
    expect(msg).toMatchObject({
      conversationId: 'whatsapp:main:13135550002@bot',
      direction: 'in',
      authorName: 'Meta AI',
      body: { type: 'text', text: 'AI 回复' }
    })
  })

  it('群消息的 participant（非 @bot）不受影响', () => {
    const msg = mapWaMessage(
      raw({
        key: {
          remoteJid: '123-456@g.us',
          fromMe: false,
          id: 'G1',
          participant: '999@s.whatsapp.net'
        }
      }),
      'main'
    )
    expect(msg?.conversationId).toBe('whatsapp:main:123-456@g.us')
    expect(msg?.direction).toBe('in')
  })
})

describe('mediaFileLength', () => {
  it('number / string / Long 风格与包裹消息', () => {
    expect(mediaFileLength({ imageMessage: { fileLength: 1234 } })).toBe(1234)
    expect(mediaFileLength({ videoMessage: { fileLength: '5678' } })).toBe(5678)
    expect(mediaFileLength({ audioMessage: { fileLength: { toNumber: () => 42 } } })).toBe(42)
    expect(
      mediaFileLength({ viewOnceMessageV2: { message: { imageMessage: { fileLength: 99 } } } })
    ).toBe(99)
  })

  it('非媒体或空消息返回 0', () => {
    expect(mediaFileLength({ conversation: 'hi' })).toBe(0)
    expect(mediaFileLength(null)).toBe(0)
  })
})

describe('isGroupJid', () => {
  it('区分群聊与私聊', () => {
    expect(isGroupJid('123-456@g.us')).toBe(true)
    expect(isGroupJid('123@s.whatsapp.net')).toBe(false)
  })
})

// extractAdReply：从入站消息里找 Click-to-WhatsApp 广告上下文（externalAdReply）。
// 这是投放归因的取数第一步——广告上下文可能挂在任意消息节点(文本/图片/视频…)的
// contextInfo 下，必须通用扫描找到它。此前零覆盖(fromAdReply 有测，但"从哪找出来"没测)。
describe('extractAdReply', () => {
  const ad = { sourceId: 'ad-123', ctwaClid: 'clk', sourceUrl: 'https://fb/ad' }

  it('从文本消息节点的 contextInfo 里取出广告上下文', () => {
    const msg = { extendedTextMessage: { text: 'hi', contextInfo: { externalAdReply: ad } } }
    expect(extractAdReply(msg)).toEqual(ad)
  })

  it('挂在图片消息节点也能找到（通用扫描，不限节点类型）', () => {
    const msg = { imageMessage: { caption: 'x', contextInfo: { externalAdReply: ad } } }
    expect(extractAdReply(msg)).toEqual(ad)
  })

  it('无广告上下文 → undefined', () => {
    expect(extractAdReply({ conversation: '普通消息' })).toBeUndefined()
    expect(extractAdReply({ imageMessage: { contextInfo: {} } })).toBeUndefined()
  })

  it('null / undefined / 非对象节点不崩', () => {
    expect(extractAdReply(null)).toBeUndefined()
    expect(extractAdReply(undefined)).toBeUndefined()
    // conversation 是字符串（非对象），不能让扫描崩掉
    expect(extractAdReply({ conversation: 'hi', messageContextInfo: null })).toBeUndefined()
  })
})
