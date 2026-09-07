import type { TranslateResult, Translator } from '../translator'

export interface LlmConfig {
  /** OpenAI 兼容接口地址，如 https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * LLM 翻译（OpenAI 兼容 chat/completions 协议）。
 * 客服口语、俚语、表情混排场景翻译质量优于传统引擎。
 */
export class LlmTranslator implements Translator {
  readonly name = 'llm'

  constructor(private readonly config: LlmConfig) {
    if (!config.baseUrl || !config.apiKey || !config.model) {
      throw new Error('LLM 翻译需要配置 baseUrl / apiKey / model')
    }
  }

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              `You are a translator for casual customer-service chat. ` +
              `Translate the user's message into ${targetLang}. ` +
              `Keep emojis and tone. Reply with ONLY the translation, no explanations.`
          },
          { role: 'user', content: text }
        ]
      }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        input_tokens?: number
        output_tokens?: number
      }
    }
    const out = data.choices?.[0]?.message?.content?.trim()
    if (!out) throw new Error('LLM 响应为空')
    const inputTokens = data.usage?.prompt_tokens ?? data.usage?.input_tokens
    const outputTokens = data.usage?.completion_tokens ?? data.usage?.output_tokens
    return {
      text: out,
      usage:
        Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
          ? { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) }
          : undefined
    }
  }
}
