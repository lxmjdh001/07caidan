import type { UnifiedMessage } from '@shared/domain'
import type { Translator } from './translator'

export interface TranslationSettings {
  /** 入站消息自动译为 displayLang */
  inboundEnabled: boolean
  /** 出站消息发送前自动译为会话目标语言 */
  outboundEnabled: boolean
  /** 坐席阅读语言 */
  displayLang: string
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  inboundEnabled: false,
  outboundEnabled: false,
  displayLang: 'zh'
}

export interface OutboundText {
  /** 实际发送的文本 */
  send: string
  /** 坐席输入的原文（与 send 不同说明经过了翻译） */
  original: string
}

/**
 * 翻译管道：所有收发消息的必经之路。
 * 引擎与开关都可运行时更换，渠道适配器完全不感知翻译的存在。
 */
export class TranslationPipeline {
  constructor(
    private translator: Translator,
    private settings: TranslationSettings = DEFAULT_TRANSLATION_SETTINGS
  ) {}

  setTranslator(translator: Translator): void {
    this.translator = translator
  }

  updateSettings(patch: Partial<TranslationSettings>): void {
    this.settings = { ...this.settings, ...patch }
  }

  getSettings(): TranslationSettings {
    return this.settings
  }

  /** 入站：文本消息附加 translation 字段（原文保留不动） */
  async processInbound(msg: UnifiedMessage): Promise<UnifiedMessage> {
    if (!this.settings.inboundEnabled || msg.body.type !== 'text') return msg
    const text = msg.body.text.trim()
    // 无文字内容（空串、纯表情/数字/符号）不值得翻译，直接跳过
    if (!text || !/\p{L}/u.test(text)) return msg
    try {
      const result = await this.translator.translate(text, this.settings.displayLang)
      // 译文与原文相同（同语言/占位引擎）时不附加，避免 UI 重复展示
      if (result.text === msg.body.text) return msg
      return {
        ...msg,
        translation: {
          text: result.text,
          sourceLang: result.sourceLang,
          targetLang: this.settings.displayLang,
          engine: this.translator.name
        }
      }
    } catch {
      // 翻译失败不阻塞消息本身
      return msg
    }
  }

  /** 出站：坐席输入 → 发送文本（翻译失败时原文发送） */
  async processOutbound(text: string, targetLang: string): Promise<OutboundText> {
    if (!this.settings.outboundEnabled) return { send: text, original: text }
    try {
      const result = await this.translator.translate(text, targetLang)
      return { send: result.text, original: text }
    } catch {
      return { send: text, original: text }
    }
  }
}
