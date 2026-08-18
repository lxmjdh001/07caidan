import Anthropic from '@anthropic-ai/sdk'
import type { StoredMessage } from './types.ts'

export interface IntentAnalysis {
  /** 意向等级 */
  intentLevel: 'high' | 'medium' | 'low' | 'unknown'
  /** 一句话摘要 */
  summary: string
  /** 关键信号（价格敏感、比价、催单等） */
  signals: string[]
  /** 建议的下一步跟进动作 */
  suggestedAction: string
}

/** 意向分析器统一接口（IntentAnalyzer 走 Claude；StubAnalyzer 走关键词，零成本） */
export interface Analyzer {
  analyze(messages: StoredMessage[]): Promise<IntentAnalysis>
}

/** 高意向关键词（下单/价格/催单等，含中英） */
const HIGH_INTENT = /买|購|购买|下单|下單|付款|怎么买|怎麼買|多少钱|多少錢|价格|價格|報價|报价|link|下单|buy|price|order|purchase|how much|checkout|pay/i
/** 中意向：提问/了解 */
const MEDIUM_INTENT = /吗|嗎|\?|？|有没有|有沒有|可以|请问|請問|了解|咨询|諮詢|详情|詳情|how|what|can you|do you|available/i

/**
 * 零成本关键词意向分析器。
 * 没有 ANTHROPIC_API_KEY 也能自动打标签：客户入站消息命中下单/价格类词 → high，
 * 提问类 → medium，其余 → low，无内容 → unknown。是 Claude 分析的免费降级/兜底。
 */
export class StubAnalyzer implements Analyzer {
  async analyze(messages: StoredMessage[]): Promise<IntentAnalysis> {
    const inbound = messages
      .filter((m) => m.direction === 'in')
      .map((m) => (m.bodyType === 'media' ? (m.caption ?? '') : (m.text ?? '')))
      .join('\n')
      .trim()
    if (!inbound) {
      return { intentLevel: 'unknown', summary: '暂无客户消息', signals: [], suggestedAction: '主动问候' }
    }
    if (HIGH_INTENT.test(inbound)) {
      return {
        intentLevel: 'high',
        summary: '客户提及下单/价格，购买意向强',
        signals: ['价格/下单意向'],
        suggestedAction: '尽快报价并引导下单'
      }
    }
    if (MEDIUM_INTENT.test(inbound)) {
      return {
        intentLevel: 'medium',
        summary: '客户在咨询了解，有一定意向',
        signals: ['咨询/提问'],
        suggestedAction: '耐心解答，挖掘需求'
      }
    }
    return { intentLevel: 'low', summary: '仅一般互动', signals: [], suggestedAction: '保持跟进' }
  }
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intentLevel: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    summary: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' } },
    suggestedAction: { type: 'string' }
  },
  required: ['intentLevel', 'summary', 'signals', 'suggestedAction']
} as const

/** 把对话记录压成给模型看的纯文本 transcript */
function toTranscript(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const who = m.direction === 'in' ? '客户' : '客服'
      let content = m.text ?? ''
      if (m.bodyType === 'media') content = `[${m.mediaType ?? '媒体'}]${m.caption ? ' ' + m.caption : ''}`
      return `${who}: ${content}`.trim()
    })
    .filter((l) => l.length > 3)
    .join('\n')
}

/**
 * 用 Claude 分析一段对话的客户意向。
 * 采用结构化输出，返回严格符合 IntentAnalysis 的对象。
 */
export class IntentAnalyzer {
  private readonly client: Anthropic
  private readonly model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async analyze(messages: StoredMessage[]): Promise<IntentAnalysis> {
    const transcript = toTranscript(messages)
    if (!transcript) {
      return {
        intentLevel: 'unknown',
        summary: '暂无足够对话内容用于分析。',
        signals: [],
        suggestedAction: '主动问候，了解客户需求。'
      }
    }

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            '你是跨境电商的销售分析助手。下面是一段客服与客户的聊天记录。' +
            '请判断客户的购买意向等级，总结意向，列出关键信号，并给出下一步跟进建议。' +
            '只依据记录内容，用中文回答。\n\n' +
            transcript
        }
      ]
    })

    const block = res.content.find((b) => b.type === 'text')
    const text = block && block.type === 'text' ? block.text : '{}'
    const parsed = JSON.parse(text) as IntentAnalysis
    return parsed
  }
}
