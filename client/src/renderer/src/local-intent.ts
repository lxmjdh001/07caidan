import type { UnifiedMessage } from '@shared/domain'

/**
 * 本地关键词意向判定（零成本、纯前端，无需后台/无需 key）。
 * 与服务端 StubAnalyzer 同一套规则：客户入站消息命中下单/价格类词 → high，
 * 提问类 → medium，其余 → low，无入站内容 → null（不显示标签）。
 * 让正在接待的客服一眼看出当前客户的购买意向，优先响应高意向。
 */
const HIGH = /买|購|购买|下单|下單|付款|怎么买|怎麼買|多少钱|多少錢|价格|價格|報價|报价|buy|price|order|purchase|how much|checkout|pay/i
const MEDIUM = /吗|嗎|\?|？|有没有|有沒有|可以|请问|請問|了解|咨询|諮詢|详情|詳情|how|what|can you|do you|available/i

export type IntentLevel = 'high' | 'medium' | 'low'

export function localIntent(messages: UnifiedMessage[]): IntentLevel | null {
  const inbound = messages
    .filter((m) => m.direction === 'in')
    .map((m) => (m.body.type === 'text' ? m.body.text : m.body.type === 'media' ? (m.body.caption ?? '') : ''))
    .join('\n')
    .trim()
  if (!inbound) return null
  if (HIGH.test(inbound)) return 'high'
  if (MEDIUM.test(inbound)) return 'medium'
  return 'low'
}
