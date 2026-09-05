import { describe, expect, it } from 'vitest'
import { mapTikTokHistoryMessage, mapTikTokWebhook } from './mapper'

const ACCOUNT = { businessId: 'business-1' }

describe('mapTikTokWebhook', () => {
  it('把企业号收到的文本映射到 conversation_id，并保存公开用户名和稳定客户标识', () => {
    const result = mapTikTokWebhook({
      event: 'im_receive_msg',
      user_openid: 'business-1',
      content: JSON.stringify({
        from: 'alice_shop',
        to: 'my_business',
        unique_identifier: 'person-1',
        from_user: { role: 'personal_account', id: 'person-1' },
        to_user: { role: 'business_account', id: 'business-1' },
        conversation_id: 'conv+1==',
        message_id: 'message-1',
        timestamp: 1_700_000_000_000,
        type: 'text',
        text: { body: 'hello' }
      })
    }, 'main', ACCOUNT)

    expect(result).toMatchObject({
      message: {
        externalId: 'message-1',
        channel: 'tiktok',
        accountId: 'main',
        conversationId: 'tiktok:main:conv+1==',
        direction: 'in',
        body: { type: 'text', text: 'hello' }
      },
      conversation: {
        externalChatId: 'conv+1==',
        title: 'alice_shop',
        publicId: '@alice_shop',
        contactId: 'tiktok:business-1:person-1',
        isGroup: false
      }
    })
  })

  it('识别企业号发出的消息为出站', () => {
    const result = mapTikTokWebhook({
      event: 'im_send_msg',
      content: {
        from: 'my_business', recipient: 'alice_shop',
        from_user: { role: 'business_account', id: 'business-1' },
        to_user: { role: 'personal_account', id: 'person-1' },
        conversation_id: 'conv-1', message_id: 'message-2', timestamp: 1_700_000_000_100,
        type: 'text', text: { body: 'reply' }
      }
    }, 'main', ACCOUNT)
    expect(result).toMatchObject({ message: { direction: 'out' } })
  })

  it('EU 精简事件要求重新拉历史，不伪造消息', () => {
    expect(mapTikTokWebhook({ event: 'im_receive_msg_eu', content: {} }, 'main', ACCOUNT))
      .toEqual({ needsHistoryRefresh: true })
  })

  it('映射图片为只能由服务器携令牌下载的引用', () => {
    const result = mapTikTokWebhook({
      event: 'im_receive_msg',
      content: {
        from_user: { role: 'personal_account', id: 'person-1' },
        to_user: { role: 'business_account', id: 'business-1' },
        conversation_id: 'conv-1', message_id: 'image-1', timestamp: 1_700_000_000_200,
        type: 'image', image: { media_id: 'media-1' }
      }
    }, 'main', ACCOUNT)
    expect(result).toMatchObject({
      message: { body: { type: 'media', mediaType: 'image' } },
      media: {
        kind: 'api', conversationId: 'conv-1', messageId: 'image-1', mediaId: 'media-1', mediaType: 'IMAGE'
      }
    })
  })
})

describe('mapTikTokHistoryMessage', () => {
  it('按 from_user 角色判断历史方向并映射分享链接', () => {
    const result = mapTikTokHistoryMessage({
      message_id: 'history-1',
      from_user: { role: 'BUSINESS_ACCOUNT', id: 'business-1' },
      timestamp: 1_700_000_000_000,
      message_type: 'SHARE_POST',
      share_post: { embed_url: 'https://www.tiktok.com/player/v1/123' }
    }, 'main', 'conv-1', ACCOUNT)
    expect(result.message).toMatchObject({
      direction: 'out',
      conversationId: 'tiktok:main:conv-1',
      body: { type: 'text', text: '[TikTok 帖子] https://www.tiktok.com/player/v1/123' }
    })
  })
})
