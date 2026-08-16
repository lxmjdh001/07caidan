import type { TranslateResult, Translator } from '../translator'

export interface GoogleCloudConfig {
  apiKey: string
}

/** Google Cloud Translation v2 官方付费 API */
export class GoogleCloudTranslator implements Translator {
  readonly name = 'google-cloud'

  constructor(private readonly config: GoogleCloudConfig) {
    if (!config.apiKey) throw new Error('Google Cloud Translation 未配置 API Key')
  }

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.config.apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: text, target: targetLang, format: 'text' }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`Google Cloud Translation HTTP ${res.status}`)
    const data = (await res.json()) as {
      data?: { translations?: Array<{ translatedText?: string; detectedSourceLanguage?: string }> }
    }
    const first = data.data?.translations?.[0]
    if (typeof first?.translatedText !== 'string') {
      throw new Error('Google Cloud Translation 响应格式异常')
    }
    return { text: first.translatedText, sourceLang: first.detectedSourceLanguage }
  }
}
