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
