import { describe, expect, it } from 'vitest'
import type { Conversation, UnifiedMessage } from '@shared/domain'
import { AutoReplyService, matchesHandoff, toContext, type AutoReplyDeps } from './auto-reply'

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
    getConfig: () => ({ enabled: true, systemPrompt: '客服', cooldownSec: 20, handoffKeywords: '人工, human' }),
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
      getConfig: () => ({ enabled: false, systemPrompt: '', cooldownSec: 20, handoffKeywords: '' })
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

  it('并发双消息只回一次 —— inFlight 挡住生成期内的第二条(冷却拦不住)', async () => {
    // 两条入站几乎同时到达：第一条还在 generate() 期间，第二条就进来了。此时冷却拦不住
    // ——lastReplyAt 要等 generate 完成才写(见实现 line 85)，生成窗口内它仍是旧值、冷却判定通过。
    // 唯一挡住重复回复的是 inFlight。缺了它，客户会瞬间收到两条 AI 回复、老板双份烧积分。
    let generated = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const { svc, sent } = makeService({
      generate: async () => {
        generated++
        await gate // 卡住第一条的生成，模拟真实网络耗时
        return { text: 'AI 回复' }
      }
    })
    const p1 = svc.onInbound(msg(), conv()) // 同步跑到 inFlight.add 后停在 generate 的 gate
    const p2 = svc.onInbound(msg(), conv()) // 此刻 inFlight 已含 c1 → 直接短路返回
    releaseGate()
    await Promise.all([p1, p2])
    expect(generated).toBe(1) // 第二条被 inFlight 挡下，没进生成
    expect(sent.length).toBe(1) // 只回一条
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

describe('转人工', () => {
  it('关键词匹配：包含式、大小写不敏感、中英分隔符都认', () => {
    const kw = '人工, 转人工，human\nagent'
    expect(matchesHandoff('我要转人工！', kw)).toBe(true)
    expect(matchesHandoff('I want a HUMAN please', kw)).toBe(true)
    expect(matchesHandoff('多少钱', kw)).toBe(false)
    expect(matchesHandoff('anything', '')).toBe(false)
  })

  it('命中关键词：停用会话自动回复 + 提醒客服 + 不生成回复', async () => {
    const paused: string[] = []
    let notified = 0
    let generated = 0
    const svc = new AutoReplyService({
      getConfig: () => ({
        enabled: true,
        systemPrompt: '',
        cooldownSec: 20,
        handoffKeywords: '人工'
      }),
      getMessages: async () => [],
      generate: async () => {
        generated++
        return { text: 'x' }
      },
      send: async () => {},
      pauseConversation: async (id) => {
        paused.push(id)
      },
      notifyHandoff: () => {
        notified++
      }
    })
    await svc.onInbound(msg({ body: { type: 'text', text: '给我转人工' } }), conv())
    expect(paused).toEqual(['c1'])
    expect(notified).toBe(1)
    expect(generated).toBe(0)
  })

  it('转人工优先于冷却：冷却期内客户喊人仍立刻停机+提醒，不被冷却吞掉', async () => {
    const paused: string[] = []
    let notified = 0
    let generated = 0
    const svc = new AutoReplyService({
      getConfig: () => ({ enabled: true, systemPrompt: '客服', cooldownSec: 20, handoffKeywords: '人工' }),
      getMessages: async () => [msg()], // 非空历史，最后一条是客户消息 → 生成路径可触发
      generate: async () => {
        generated++
        return { text: 'x' }
      },
      send: async () => {},
      pauseConversation: async (id) => {
        paused.push(id)
      },
      notifyHandoff: () => {
        notified++
      }
    })
    // 先一条普通消息触发自动回复 → 进入冷却
    await svc.onInbound(msg({ body: { type: 'text', text: '多少钱' } }), conv())
    expect(generated).toBe(1)
    expect(svc.shouldReply(msg(), conv())).toBe(false) // 确认此刻在冷却期
    // 冷却期内客户喊「转人工」：仍立刻停机+提醒（转人工优先于一切），且不生成新回复
    await svc.onInbound(msg({ body: { type: 'text', text: '给我转人工' } }), conv())
    expect(paused).toEqual(['c1'])
    expect(notified).toBe(1)
    expect(generated).toBe(1) // 没因喊人再生成，冷却没吞掉转人工
  })

  it('语音转写文本同样能触发转人工', async () => {
    const paused: string[] = []
    const svc = new AutoReplyService({
      getConfig: () => ({
        enabled: true,
        systemPrompt: '',
        cooldownSec: 20,
        handoffKeywords: '人工'
      }),
      getMessages: async () => [],
      generate: async () => ({ text: 'x' }),
      send: async () => {},
      pauseConversation: async (id) => {
        paused.push(id)
      }
    })
    await svc.onInbound(
      msg({ body: { type: 'media', mediaType: 'audio', mediaId: 'v', transcript: '我要人工客服' } }),
      conv()
    )
    expect(paused).toEqual(['c1'])
  })

  it('会话未开自动回复时不触发转人工逻辑（没开就无所谓停）', async () => {
    const paused: string[] = []
    const svc = new AutoReplyService({
      getConfig: () => ({ enabled: true, systemPrompt: '', cooldownSec: 20, handoffKeywords: '人工' }),
      getMessages: async () => [],
      generate: async () => ({ text: 'x' }),
      send: async () => {},
      pauseConversation: async (id) => {
        paused.push(id)
      }
    })
    await svc.onInbound(msg({ body: { type: 'text', text: '人工' } }), conv({ autoReply: false }))
    expect(paused).toEqual([])
  })
})
