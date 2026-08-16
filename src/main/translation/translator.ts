/**
 * 翻译引擎接口。实现可以是 Google / DeepL / LLM / 本地引擎，
 * 通过 TranslationPipeline 统一接入收发两个方向。
 */
export interface TranslateResult {
  text: string
  sourceLang?: string
}

export interface Translator {
  readonly name: string
  translate(text: string, targetLang: string): Promise<TranslateResult>
}
