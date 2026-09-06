/**
 * 翻译引擎接口。实现可以是 Google / DeepL / LLM / 本地引擎，
 * 通过 TranslationPipeline 统一接入收发两个方向。
 */
export interface TranslateResult {
  text: string
  sourceLang?: string
  /** 后台引擎已完成字符扣费，管道不得重复上报。 */
  metered?: boolean
}

export interface TranslateContext {
  channel?: string
  accountId?: string
  direction?: 'in' | 'out'
  /** 同一次翻译的稳定计费键；消息重投时复用，避免重复扣字符。 */
  requestId?: string
}

export interface Translator {
  readonly name: string
  translate(text: string, targetLang: string, context?: TranslateContext): Promise<TranslateResult>
}
