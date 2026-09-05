import { describe, expect, it } from 'vitest'
import { mapXMessage, previewXMessage } from './mapper'

describe('X mapper', () => {
  it('映射入站文本并保留 X 数字用户作用域', () => {
    const mapped = mapXMessage({
      id: 'evt-1',
      sender_id: '200',
      dm_conversation_id: '100-200',
      created_at: '2026-09-04T08:00:00.000Z',
      text: 'hello'
    }, 'main', '100-200', { userId: '100' })
    expect(mapped.message).toMatchObject({
      externalId: 'evt-1',
      channel: 'x',
      conversationId: 'x:main:100-200',
      direction: 'in',
      body: { type: 'text', text: 'hello' }
    })
  })

  it('映射图片附件与文字说明', () => {
    const input = {
      id: 'evt-2', sender_id: '100', text: 'caption',
      _media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]
    }
    const mapped = mapXMessage(input, 'main', '100-200', { userId: '100' })
    expect(mapped.message.direction).toBe('out')
    expect(mapped.message.body).toMatchObject({ type: 'media', mediaType: 'image', caption: 'caption' })
    expect(mapped.mediaUrl).toBe('https://pbs.twimg.com/media/a.jpg')
    expect(previewXMessage(input)).toBe('[图片] caption')
  })
})
