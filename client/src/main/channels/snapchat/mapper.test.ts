import { describe, expect, it } from 'vitest'
import { mapSnapchatMessage, previewSnapchatMessage } from './mapper'

describe('Snapchat mapper', () => {
  it('使用服务器标注的方向、ID 与时间', () => {
    const raw = { _id: 'snap-1', _direction: 'out' as const, _text: '合作确认', _timestamp: 1_800_000_000_000 }
    expect(mapSnapchatMessage(raw, 'brand', 'conversation-1')).toMatchObject({
      externalId: 'snap-1',
      channel: 'snapchat',
      conversationId: 'snapchat:brand:conversation-1',
      direction: 'out',
      body: { type: 'text', text: '合作确认' },
      timestamp: 1_800_000_000_000
    })
    expect(previewSnapchatMessage(raw)).toBe('合作确认')
  })

  it('兼容官方 text_message 对象', () => {
    const mapped = mapSnapchatMessage({
      message_id: 'snap-2',
      text_message: { text: 'hello' },
      created_at: '2026-09-04T08:00:00Z'
    }, 'brand', 'conversation-1')
    expect(mapped.direction).toBe('in')
    expect(mapped.body).toEqual({ type: 'text', text: 'hello' })
  })
})
