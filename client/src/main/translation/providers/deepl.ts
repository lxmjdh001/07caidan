import type { TranslateResult, Translator } from '../translator'

/** DeepL 语言代码映射（DeepL 用大写，中文只有 ZH） */
const LANG_MAP: Record<string, string> = {
  'zh-CN': 'ZH',
  'zh-TW': 'ZH-HANT',
  en: 'EN',
  pt: 'PT-BR'
}

export interface DeepLConfig {
  apiKey: string
}

/** DeepL 官方 API（Key 以 :fx 结尾为免费版，走 api-free 域名） */
export class DeepLTranslator implements Translator {
  readonly name = 'deepl'
  private readonly host: string

  constructor(private readonly config: DeepLConfig) {
    if (!config.apiKey) throw new Error('DeepL 未配置 API Key')
    this.host = config.apiKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com'
  }

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const target = LANG_MAP[targetLang] ?? targetLang.toUpperCase()
    const res = await fetch(`https://${this.host}/v2/translate`, {
      method: 'POST',
      headers: {
        authorization: `DeepL-Auth-Key ${this.config.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: [text], target_lang: target }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`)
    const data = (await res.json()) as {
      translations?: Array<{ text?: string; detected_source_language?: string }>
    }
    const first = data.translations?.[0]
    if (typeof first?.text !== 'string') throw new Error('DeepL 响应格式异常')
    return { text: first.text, sourceLang: first.detected_source_language?.toLowerCase() }
  }
}
