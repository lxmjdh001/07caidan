import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, UnifiedMessage } from '@shared/domain'

// notifyInbound 依赖 electron 的 Notification/BrowserWindow/app —— 这里 mock 掉，专测它的
// 「弹不弹」决策：只入站、只在未聚焦时弹、同会话短时间内合并不刷屏。这套决策此前零覆盖
// （notifier.test 只测了 preview/truncate 纯函数）。
const state = { focused: false, supported: true, shown: [] as Array<{ title: string; body: string; silent: boolean }> }

vi.mock('electron', () => ({
  app: { isReady: () => true, setBadgeCount: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isFocused: () => state.focused, isVisible: () => true }]
  },
  Notification: class {
    static isSupported(): boolean {
      return state.supported
    }
    private readonly rec: { title: string; body: string; silent: boolean }
    constructor(o: { title: string; body: string; silent: boolean }) {
      this.rec = { title: o.title, body: o.body, silent: o.silent }
    }
    on(): this {
      return this
    }
    show(): void {
      state.shown.push(this.rec)
    }
  }
}))
vi.mock('@shared/branding', () => ({ brand: { appName: 'WzzScrm' } }))

const { Notifier } = await import('./notifier')

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
  } as UnifiedMessage
}
const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({ id: 'c1', title: '客户', channel: 'whatsapp', accountId: 'a', isGroup: false, ...over } as Conversation)

function make(cfg: Partial<{ enabled: boolean; showPreview: boolean; sound: boolean }> = {}) {
  return new Notifier({
    getConfig: () => ({ enabled: true, showPreview: true, sound: true, ...cfg }) as never,
    onActivate: vi.fn()
  })
}

describe('Notifier.notifyInbound 决策', () => {
  beforeEach(() => {
    state.focused = false
    state.supported = true
    state.shown = []
  })

  it('入站 + 未聚焦 → 弹通知', () => {
    make().notifyInbound(msg(), conv())
    expect(state.shown).toHaveLength(1)
  })

  it('出站消息不弹（不给自己发的消息弹通知）', () => {
    make().notifyInbound(msg({ direction: 'out' }), conv())
    expect(state.shown).toHaveLength(0)
  })

  it('窗口已聚焦时不弹（用户就在看，应用内角标够了）', () => {
    state.focused = true
    make().notifyInbound(msg(), conv())
    expect(state.shown).toHaveLength(0)
  })

  it('通知关闭时不弹', () => {
    make({ enabled: false }).notifyInbound(msg(), conv())
    expect(state.shown).toHaveLength(0)
  })

  it('会话静音时不弹通知也不播放声音', () => {
    make().notifyInbound(msg(), conv({ muted: true }))
    expect(state.shown).toHaveLength(0)
  })

  it('同一会话短时间内连发只弹一次（合并防刷屏）', () => {
    const n = make()
    n.notifyInbound(msg(), conv())
    n.notifyInbound(msg(), conv()) // 4s 内的第二条同会话
    expect(state.shown).toHaveLength(1)
  })

  it('不同会话各弹各的（合并只按会话）', () => {
    const n = make()
    n.notifyInbound(msg({ conversationId: 'c1' }), conv({ id: 'c1' }))
    n.notifyInbound(msg({ conversationId: 'c2' }), conv({ id: 'c2' }))
    expect(state.shown).toHaveLength(2)
  })

  it('showPreview 决定正文是原文还是类型描述', () => {
    make({ showPreview: true }).notifyInbound(msg({ body: { type: 'text', text: '你好呀' } }), conv())
    expect(state.shown[0]!.body).toBe('你好呀')
    state.shown = []
    make({ showPreview: false }).notifyInbound(msg({ body: { type: 'text', text: '你好呀' } }), conv({ id: 'c2' }))
    expect(state.shown[0]!.body).not.toBe('你好呀') // 隐藏正文，给类型描述
  })

  it('账号标签拼进标题（客服知道是哪个号来的客）', () => {
    make().notifyInbound(msg(), conv({ title: '张三' }), '主号')
    expect(state.shown[0]!.title).toBe('张三 · 主号')
  })
})
