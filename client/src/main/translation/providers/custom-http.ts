import type { TranslateResult, Translator } from '../translator'

export interface CustomHttpConfig {
  /** 用户自建/第三方翻译服务地址 */
  url: string
  /** 可选，作为 Authorization: Bearer 发送 */
  apiKey?: string
}

/**
 * 用户自定义翻译接口。约定协议（README 有文档）：
 *   POST <url>  body: { "text": "...", "target_lang": "zh-CN" }
 *   响应:       { "text": "译文", "source_lang": "en"? }
 * 用户可用几行代码把任意引擎（DeepL/Google 付费/自家模型）包装成该协议。
 */
export class CustomHttpTranslator implements Translator {
  readonly name = 'custom-http'

  constructor(private readonly config: CustomHttpConfig) {
    if (!config.url) throw new Error('自定义翻译接口未配置 URL')
  }

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`

    const res = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, target_lang: targetLang }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`custom-http HTTP ${res.status}`)

    const data = (await res.json()) as { text?: unknown; source_lang?: unknown }
    if (typeof data.text !== 'string') {
      throw new Error('自定义翻译接口响应缺少 text 字段')
    }
    return {
      text: data.text,
      sourceLang: typeof data.source_lang === 'string' ? data.source_lang : undefined
    }
  }
}
