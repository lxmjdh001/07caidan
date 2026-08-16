import { describe, expect, it } from 'vitest'
import type { Conversation, UnifiedMessage } from '@shared/domain'
import { AutoReplyService, toContext, type AutoReplyDeps } from './auto-reply'

function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: Math.random().toString(36).slice(2),
    conversationId: 'c1',
    channel: 'whatsapp',
    accountId: 'a',
    direction: 'in',
    body: { type: 'text', text: '多少钱' },
    timestamp: Date.now(),
    status: 'delivered',
    ...over
  }
}

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    channel: 'whatsapp',
    accountId: 'a',
    externalChatId: 'x',
    title: '客户',
    isGroup: false,
    lastMessageAt: 0,
    lastMessagePreview: '',
    unreadCount: 0,
    autoReply: true,
    ...over
  }
}

function makeService(over: Partial<AutoReplyDeps> = {}): {
  svc: AutoReplyService
  sent: string[]
  generated: number
} {
  const state = { sent: [] as string[], generated: 0 }
  const svc = new AutoReplyService({
    getConfig: () => ({ enabled: true, systemPrompt: '客服', cooldownSec: 20 }),
    getMessages: async () => [msg()],
    generate: async () => {
      state.generated++
      return { text: 'AI 回复' }
    },
    send: async (_id, text) => {
      state.sent.push(text)
    },
    ...over
  })
  return { svc, sent: state.sent, generated: 0 } as never
}

describe('shouldReply 触发条件', () => {
  it('全局关闭不回', () => {
    const { svc } = makeService({
      getConfig: () => ({ enabled: false, systemPrompt: '', cooldownSec: 20 })
    })
    expect(svc.shouldReply(msg(), conv())).toBe(false)
  })
  it('会话未开启不回', () => {
    const { svc } = makeService()
    expect(svc.shouldReply(msg(), conv({ autoReply: false }))).toBe(false)
  })
  it('自己发的消息不回（否则会自我循环）', () => {
    const { svc } = makeService()
    expect(svc.shouldReply(msg({ direction: 'out' }), conv())).toBe(false)
  })
  it('群聊不回', () => {
    const { svc } = makeService()
    expect(svc.shouldReply(msg(), conv({ isGroup: true }))).toBe(false)
  })
  it('两层开关都开且是入站私聊 → 回', () => {
    const { svc } = makeService()
    expect(svc.shouldReply(msg(), conv())).toBe(true)
  })
})

describe('冷却与并发', () => {
  it('冷却期内不再触发 —— 防机器人互怼烧积分', async () => {
    const { svc, sent } = makeService()
    await svc.onInbound(msg(), conv())
    expect(sent.length).toBe(1)
    // 紧接着又来一条
    expect(svc.shouldReply(msg(), conv())).toBe(false)
    await svc.onInbound(msg(), conv())
    expect(sent.length).toBe(1)
  })

  it('生成失败不影响收消息，且不记冷却（下条消息还能触发）', async () => {
    let calls = 0
    const { svc, sent } = makeService({
      generate: async () => {
        calls++
        throw new Error('积分不足')
      }
    })
    await svc.onInbound(msg(), conv())
    expect(sent.length).toBe(0)
    // 失败未记冷却，仍可再次尝试
    expect(svc.shouldReply(msg(), conv())).toBe(true)
    await svc.onInbound(msg(), conv())
    expect(calls).toBe(2)
  })

  it('最后一条不是客户消息时不回（客服刚说完话，别抢话）', async () => {
    const { svc, sent } = makeService({
      getMessages: async () => [msg(), msg({ direction: 'out', body: { type: 'text', text: '你好' } })]
    })
    await svc.onInbound(msg(), conv())
    expect(sent.length).toBe(0)
  })

  it('空回复不发送', async () => {
    const { svc, sent } = makeService({ generate: async () => ({ text: '   ' }) })
    await svc.onInbound(msg(), conv())
    expect(sent.length).toBe(0)
  })
})

describe('toContext', () => {
  it('入站为 user、出站为 assistant，最多 12 条', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      msg({ direction: i % 2 ? 'out' : 'in', body: { type: 'text', text: `m${i}` } })
    )
    const ctx = toContext(history)
    expect(ctx.length).toBe(12)
    expect(ctx[ctx.length - 1]!.role).toBe('assistant')
  })

  it('语音优先用转写文本 —— 自动回复要能"听懂"语音', () => {
    const ctx = toContext([
      msg({
        body: {
          type: 'media',
          mediaType: 'audio',
          mediaId: 'v',
          transcript: '你们发货吗'
        }
      })
    ])
    expect(ctx[0]!.content).toBe('你们发货吗')
  })

  it('未转写的媒体用占位符', () => {
    const ctx = toContext([msg({ body: { type: 'media', mediaType: 'image', mediaId: 'i' } })])
    expect(ctx[0]!.content).toBe('[image]')
  })
})
