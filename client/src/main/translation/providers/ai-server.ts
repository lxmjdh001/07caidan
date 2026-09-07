import { randomUUID } from 'node:crypto'
import type { TranslateContext, Translator, TranslateResult } from '../translator'

export interface AiServerConfig {
  /** 后台地址与登录令牌（来自同步配置） */
  getBackend: () => { serverUrl?: string; token?: string }
  /** 降级引擎：积分不足 / 后台未配模型时回落（通常是免费 Google） */
  fallback?: Translator
  fetchImpl?: typeof fetch
}

/**
 * AI 翻译（后台代理）。
 *
 * 请求发给自己的后台 /api/ai/translate，由后台持有供应商密钥、按积分计费。
 * 客户端永远不接触 AI 供应商的 API Key。
 *
 * 降级链路（用户没积分时翻译不能整个失效，客服还要干活）：
 * - 402（积分/余额不足）→ 回落免费引擎
 * - 501（管理员没配模型）→ 回落免费引擎
 * - 其它错误（网络/供应商挂了）→ 同样回落，翻译永远尽力而为
 */
export class AiServerTranslator implements Translator {
  readonly name = 'ai-server'
  private readonly cfg: AiServerConfig
  /**
   * 命中过 402/501 后短暂停用 AI 通道，避免每条消息都白打一次注定失败的请求。
   * 到期后重试 —— 用户可能刚充了值。
   */
  private suspendedUntil = 0

  constructor(cfg: AiServerConfig) {
    this.cfg = cfg
  }

  async translate(text: string, targetLang: string, context?: TranslateContext): Promise<TranslateResult> {
    const { serverUrl, token } = this.cfg.getBackend()
    if (!serverUrl || !token) return this.fallback(text, targetLang, '未登录后台')
    if (Date.now() < this.suspendedUntil) return this.fallback(text, targetLang, '冷却中')

    const doFetch = this.cfg.fetchImpl ?? fetch
    try {
      const res = await doFetch(`${serverUrl.replace(/\/$/, '')}/api/ai/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, targetLang, ...context, requestId: context?.requestId ?? randomUUID() })
      })
      if (res.ok) {
        const json = (await res.json()) as { text?: string; metered?: boolean; usage?: { inputTokens?: number; outputTokens?: number } }
        if (typeof json.text === 'string' && json.text) {
          return {
            text: json.text,
            metered: json.metered === true,
            billingEngine: 'ai-server',
            usage:
              Number.isFinite(json.usage?.inputTokens) && Number.isFinite(json.usage?.outputTokens)
                ? { inputTokens: Number(json.usage?.inputTokens), outputTokens: Number(json.usage?.outputTokens) }
                : undefined
          }
        }
        return this.fallback(text, targetLang, '空响应')
      }
      // 付费/配置类失败进入冷却，别的错误只降级本次
      if (res.status === 402 || res.status === 501) {
        this.suspendedUntil = Date.now() + 5 * 60 * 1000
      }
      return this.fallback(text, targetLang, `HTTP ${res.status}`)
    } catch (err) {
      return this.fallback(text, targetLang, String(err))
    }
  }

  private async fallback(
    text: string,
    targetLang: string,
    _reason: string
  ): Promise<TranslateResult> {
    if (this.cfg.fallback) {
      const result = await this.cfg.fallback.translate(text, targetLang)
      return { ...result, billingEngine: result.billingEngine ?? this.cfg.fallback.name }
    }
    // 没有降级引擎时原样返回 —— 发不出翻译也不能拦住消息本身
    return { text }
  }
}
