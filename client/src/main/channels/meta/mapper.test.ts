import { describe, expect, it } from 'vitest'
import { mapMetaHistoryMessage, mapMetaWebhook } from './mapper'

const ACCOUNT = { assetId: 'page-100', pageId: 'page-100' }

describe('mapMetaWebhook', () => {
  it('把 Messenger 入站文本映射到对应客户会话', () => {
    const result = mapMetaWebhook({
      object: 'page',
      entryId: 'page-100',
      event: {
        sender: { id: 'psid-200' },
        recipient: { id: 'page-100' },
        timestamp: 1_700_000_000_000,
        message: { mid: 'm-1', text: 'hello' }
      }
    }, 'facebook', 'main', ACCOUNT)

    expect(result?.message).toMatchObject({
      externalId: 'm-1',
      channel: 'facebook',
      accountId: 'main',
      conversationId: 'facebook:main:psid-200',
      direction: 'in',
      body: { type: 'text', text: 'hello' }
    })
    expect(result?.conversation).toEqual({ externalChatId: 'psid-200', isGroup: false })
  })

  it('识别 Page echo 为出站消息，避免把自己建成客户会话', () => {
    const result = mapMetaWebhook({
      entryId: 'page-100',
      event: {
        sender: { id: 'page-100' },
        recipient: { id: 'psid-200' },
        timestamp: 1_700_000_000_010,
        message: { mid: 'm-2', text: 'reply', is_echo: true }
      }
    }, 'facebook', 'main', ACCOUNT)

    expect(result?.message.direction).toBe('out')
    expect(result?.message.conversationId).toBe('facebook:main:psid-200')
  })

  it('映射 Instagram 图片并保留受控下载地址', () => {
    const result = mapMetaWebhook({
      object: 'instagram',
      entryId: 'ig-100',
      event: {
        sender: { id: 'igsid-300' },
        recipient: { id: 'ig-100' },
        timestamp: 1_700_000_000_020,
        message: {
          mid: 'ig-m-1',
          text: 'photo',
          attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/photo.jpg' } }]
        }
      }
    }, 'instagram', 'ig-main', { assetId: 'ig-100', pageId: 'ig-100' })

    expect(result?.message.body).toMatchObject({ type: 'media', mediaType: 'image', caption: 'photo' })
    expect(result?.mediaUrl).toBe('https://lookaside.fbsbx.com/photo.jpg')
  })

  it('忽略送达/已读等没有消息正文的事件', () => {
    expect(mapMetaWebhook({
      entryId: 'page-100',
      event: { sender: { id: 'psid-200' }, recipient: { id: 'page-100' }, timestamp: 1 }
    }, 'facebook', 'main', ACCOUNT)).toBeUndefined()
  })
})

describe('mapMetaHistoryMessage', () => {
  it('根据发送者是否为业务资产识别历史消息方向', () => {
    const result = mapMetaHistoryMessage({
      id: 'history-1',
      createdTime: 1_700_000_000_000,
      fromId: 'page-100',
      fromName: 'Shop',
      toIds: ['psid-200'],
      text: 'sent before',
      attachments: []
    }, 'facebook', 'main', 'psid-200', ACCOUNT)

    expect(result.message).toMatchObject({
      direction: 'out',
      authorName: 'Shop',
      conversationId: 'facebook:main:psid-200',
      body: { type: 'text', text: 'sent before' }
    })
  })
})
