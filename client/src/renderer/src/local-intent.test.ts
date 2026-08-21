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
  it('只看客户入站：客服自己说「价格/下单」不把标签带成 high（与服务端同口径）', () => {
    // 客户只说「你好」，客服回复含「多少钱/下单」。意向是客户的意向——不能被客服用词带高，
    // 否则客服接待时头部标签乱亮高意向。这条对应服务端 StubAnalyzer 已修的同类问题。
    const r = localIntent([msg('in', '你好'), msg('out', '这个多少钱，随时可以下单')])
    expect(r).toBe('low')
  })
  it('媒体 caption 也纳入', () => {
    const m = { ...msg('in', ''), body: { type: 'media', mediaType: 'image', caption: '多少钱' } } as UnifiedMessage
    expect(localIntent([m])).toBe('high')
  })
})
