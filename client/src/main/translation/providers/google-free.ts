import type { TranslateResult, Translator } from '../translator'

/** 界面语言代码 → Google 语言代码 */
const LANG_ALIAS: Record<string, string> = {
  zh: 'zh-CN',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW'
}

/**
 * 免费翻译引擎（默认）：Google Translate 网页版的公开接口，无需 API Key。
 * 注意：非官方接口，可用性无 SLA，量大或商用建议在设置中切换为
 * 自定义接口 / 付费引擎。两个公开端点都不可用时由 TranslationPipeline 呈现错误。
 */
export class GoogleFreeTranslator implements Translator {
  readonly name = 'google-free'

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const tl = LANG_ALIAS[targetLang] ?? targetLang
    // translate.googleapis.com 在部分网络环境会限流并返回 HTML；备用端点仍提供相同译文。
    const urls = [
      'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto' +
        `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`,
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
        `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`
    ]

    let lastError: unknown
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return parseGoogleResponse(await res.json())
      } catch (error) {
        lastError = error
      }
    }

    throw new Error(`Google 翻译不可用：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
}

/** Google 的两个公开端点返回的数组层级不同，统一为内部结果。 */
function parseGoogleResponse(data: unknown): TranslateResult {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google 翻译响应格式异常')
  }
  const first = data[0] as unknown[]

  // clients5: [["translated text", "source-language"]]
  if (typeof first[0] === 'string') {
    return {
      text: first[0],
      sourceLang: typeof first[1] === 'string' ? first[1] : undefined
    }
  }

  // gtx: [[["translated chunk", "source chunk", ...], ...], null, "source-language", ...]
  const text = first
    .filter((segment): segment is unknown[] => Array.isArray(segment))
    .map((segment) => (typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
  if (!text) throw new Error('Google 翻译返回空结果')
  return { text, sourceLang: typeof data[2] === 'string' ? data[2] : undefined }
}
