import { describe, expect, it } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import { localIntent } from './local-intent'

function msg(dir: 'in' | 'out', text: string): UnifiedMessage {
  return {
    id: 'm', channel: 'whatsapp', accountId: 'a', conversationId: 'c',
    direction: dir, body: { type: 'text', text }, timestamp: 1, status: 'delivered'
  } as UnifiedMessage
}

describe('localIntent（客户端本地关键词意向）', () => {
  it('下单/价格 → high', () => {
    expect(localIntent([msg('in', '这个多少钱？怎么买')])).toBe('high')
    expect(localIntent([msg('in', 'can I order this?')])).toBe('high')
  })
  it('提问 → medium', () => {
    expect(localIntent([msg('in', '有货吗？')])).toBe('medium')
  })
  it('一般互动 → low', () => {
    expect(localIntent([msg('in', '你好')])).toBe('low')
  })
  it('只有出站/无入站 → null', () => {
    expect(localIntent([msg('out', '多少钱')])).toBeNull()
    expect(localIntent([])).toBeNull()
  })
  it('媒体 caption 也纳入', () => {
    const m = { ...msg('in', ''), body: { type: 'media', mediaType: 'image', caption: '多少钱' } } as UnifiedMessage
    expect(localIntent([m])).toBe('high')
  })
})
