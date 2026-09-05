import type { Conversation, UnifiedMessage } from '@shared/domain'
import type { AutoReplyConfig } from '@shared/settings'

export interface AutoReplyDeps {
  getConfig: () => AutoReplyConfig
  /** 取会话近况作为上下文 */
  getMessages: (conversationId: string) => Promise<UnifiedMessage[]>
  /** 调后台生成回复（/api/ai/reply） */
  generate: (body: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    system?: string
  }) => Promise<{ text: string }>
  /** 发出回复（走 prepared 跳过出站翻译 —— 模型已按客户语言作答，再翻一次会翻坏） */
  send: (conversationId: string, text: string) => Promise<void>
  /** 多设备幂等抢占；false 表示另一台电脑已经负责这条来信。 */
  claim?: (message: UnifiedMessage) => Promise<boolean>
  /** 客户要求人工：停用该会话的自动回复 */
  pauseConversation?: (conversationId: string) => Promise<void>
  /** 提醒客服接管（系统通知） */
  notifyHandoff?: (conversation: Conversation) => void
  log?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void }
}

/** 上下文最多带多少条消息 */
const CONTEXT_LIMIT = 12

/**
 * AI 自动回复调度。
 *
 * 触发条件（全部满足才回）：全局开关 + 会话开关、入站私聊消息、
 * 冷却期外、该会话没有正在生成中的回复。
 *
 * 冷却的意义不只是省积分：如果对面也是个机器人，没有冷却就是两个
 * 机器人无限互怼，积分几分钟烧光。
 */
export class AutoReplyService {
  private readonly deps: AutoReplyDeps
  /** 会话 → 上次自动回复时间 */
  private readonly lastReplyAt = new Map<string, number>()
  /** 正在生成中的会话，防并发双回复 */
  private readonly inFlight = new Set<string>()

  constructor(deps: AutoReplyDeps) {
    this.deps = deps
  }

  /** 判定是否应触发（纯逻辑，便于单测） */
  shouldReply(message: UnifiedMessage, conversation: Conversation, now = Date.now()): boolean {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled) return false
    if (!conversation.autoReply) return false
    if (message.direction !== 'in') return false
    if (conversation.isGroup) return false
    if (message.body.type === 'unsupported') return false
    if (this.inFlight.has(conversation.id)) return false
    const last = this.lastReplyAt.get(conversation.id) ?? 0
    if (now - last < Math.max(5, cfg.cooldownSec) * 1000) return false
    return true
  }

  /** 入站消息钩子；不满足条件时静默返回 */
  async onInbound(message: UnifiedMessage, conversation: Conversation): Promise<void> {
    // 转人工优先于一切：哪怕在冷却期，客户喊人也要立刻停机器并提醒
    if (
      conversation.autoReply &&
      message.direction === 'in' &&
      matchesHandoff(inboundText(message), this.deps.getConfig().handoffKeywords)
    ) {
      await this.deps.pauseConversation?.(conversation.id)
      this.deps.notifyHandoff?.(conversation)
      this.deps.log?.info('客户要求人工，自动回复已停用', { conversationId: conversation.id })
      return
    }
    if (!this.shouldReply(message, conversation)) return
    const cfg = this.deps.getConfig()
    this.inFlight.add(conversation.id)
    try {
      if (this.deps.claim && !(await this.deps.claim(message))) return
      const history = await this.deps.getMessages(conversation.id)
      const context = toContext(history)
      if (context.length === 0 || context[context.length - 1]!.role !== 'user') return

      const r = await this.deps.generate({ messages: context, system: cfg.systemPrompt })
      const text = r.text.trim()
      if (!text) return

      // 先记冷却再发送：发送口的失败重试不该绕过冷却
      this.lastReplyAt.set(conversation.id, Date.now())
      await this.deps.send(conversation.id, text)
      this.deps.log?.info('自动回复已发送', { conversationId: conversation.id })
    } catch (err) {
      // 自动回复失败绝不能影响收消息；记日志即可
      this.deps.log?.warn('自动回复失败', { conversationId: conversation.id, err: String(err) })
    } finally {
      this.inFlight.delete(conversation.id)
    }
  }
}

/** 会话历史 → 模型上下文。媒体消息用占位文本，让模型知道对话里发生过什么 */
export function toContext(
  history: UnifiedMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of history.slice(-CONTEXT_LIMIT)) {
    const content = textOf(m)
    if (!content) continue
    out.push({ role: m.direction === 'in' ? 'user' : 'assistant', content })
  }
  return out
}

function textOf(m: UnifiedMessage): string {
  const b = m.body
  if (b.type === 'text') return b.text
  if (b.type === 'media') {
    // 语音已有转写就用转写 —— 这是自动回复能"听懂"语音的关键一环
    if (b.mediaType === 'audio' && b.transcript) return b.transcript
    if (b.caption) return b.caption
    return `[${b.mediaType}]`
  }
  return ''
}

/** 入站消息的可读文本（含语音转写），供转人工关键词匹配 */
function inboundText(m: UnifiedMessage): string {
  return textOf(m)
}

/**
 * 转人工关键词匹配。
 * 大小写不敏感；关键词按逗号/换行拆分；空配置不匹配任何内容。
 * 用「包含」而不是全等 —— 客户说的是"我要转人工！"而不是干净的关键词。
 */
export function matchesHandoff(text: string, keywords: string): boolean {
  if (!text || !keywords.trim()) return false
  const lower = text.toLowerCase()
  return keywords
    .split(/[,，\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .some((k) => lower.includes(k))
}
