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
 * 自定义接口 / 付费引擎。失败由 TranslationPipeline 兜底（展示原文）。
 */
export class GoogleFreeTranslator implements Translator {
  readonly name = 'google-free'

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    const tl = LANG_ALIAS[targetLang] ?? targetLang
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
      `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`google-free HTTP ${res.status}`)

    // 响应结构: [[[译文片段, 原文片段, ...], ...], null, 源语言, ...]
    const data = (await res.json()) as [Array<[string, ...unknown[]]>, unknown, string?]
    const segments = data[0]
    if (!Array.isArray(segments)) throw new Error('google-free 响应格式异常')

    return {
      text: segments.map((seg) => seg[0] ?? '').join(''),
      sourceLang: typeof data[2] === 'string' ? data[2] : undefined
    }
  }
}
