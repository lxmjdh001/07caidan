import type { TranslateResult, Translator } from './translator'

/** 占位引擎：原样返回。接入 Google/DeepL/LLM 前的默认实现。 */
export class PassthroughTranslator implements Translator {
  readonly name = 'passthrough'

  async translate(text: string): Promise<TranslateResult> {
    return { text }
  }
}
