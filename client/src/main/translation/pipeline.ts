import type { UnifiedMessage } from '@shared/domain'
import { createHash, randomUUID } from 'node:crypto'
import type { Translator } from './translator'

export interface TranslationUsageCharge {
  requestId: string
  characters: number
  engine: string
  channel?: string
  accountId?: string
  direction: 'in' | 'out'
}

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

export interface InboundResult {
  message: UnifiedMessage
  /** 引擎识别到的来信语言（客户语言自动检测的来源） */
  detectedLang?: string
}

export interface OutboundText {
  /** 实际发送的文本 */
  send: string
  /** 坐席输入的原文（与 send 不同说明经过了翻译） */
  original: string
  /** 执行翻译的引擎名（未翻译时为空） */
  engine?: string
  /** 翻译失败原因；有值时不得把原文误当作译文发送。 */
  error?: string
}

/**
 * 翻译管道：所有收发消息的必经之路。
 * 引擎与开关都可运行时更换，渠道适配器完全不感知翻译的存在。
 */
export class TranslationPipeline {
  private usageRecorder?: (usage: TranslationUsageCharge) => Promise<void>

  constructor(
    private translator: Translator,
    private settings: TranslationSettings = DEFAULT_TRANSLATION_SETTINGS
  ) {}

  setTranslator(translator: Translator): void {
    this.translator = translator
  }

  setUsageRecorder(recorder: ((usage: TranslationUsageCharge) => Promise<void>) | undefined): void {
    this.usageRecorder = recorder
  }

  updateSettings(patch: Partial<TranslationSettings>): void {
    this.settings = { ...this.settings, ...patch }
  }

  getSettings(): TranslationSettings {
    return this.settings
  }

  /** 入站：文本消息附加 translation 字段（原文保留不动），并带回语言检测结果 */
  async processInbound(msg: UnifiedMessage): Promise<InboundResult> {
    if (!this.settings.inboundEnabled || msg.body.type !== 'text') return { message: msg }
    const text = msg.body.text
    // 无文字内容（空串、纯表情/数字/符号）不值得翻译，直接跳过
    if (!text.trim() || !/\p{L}/u.test(text)) return { message: msg }
    try {
      const context = {
        channel: msg.channel,
        accountId: msg.accountId,
        direction: 'in' as const,
        requestId: stableInboundRequestId(msg)
      }
      const result = await this.translator.translate(text, this.settings.displayLang, context)
      const detectedLang = normalizeDetectedLang(result.sourceLang)
      // 译文与原文相同（同语言/占位引擎）时不附加，避免 UI 重复展示
      if (result.text === msg.body.text) return { message: msg, detectedLang }
      await this.recordUsage(text, result.metered, context)
      return {
        message: {
          ...msg,
          translation: {
            text: result.text,
            sourceLang: result.sourceLang,
            targetLang: this.settings.displayLang,
            engine: this.translator.name
          }
        },
        detectedLang
      }
    } catch {
      // 翻译失败不阻塞消息本身
      return { message: msg }
    }
  }

  /** 出站：坐席输入 → 发送文本（翻译失败时由调用方明确处理） */
  async processOutbound(
    text: string,
    targetLang: string,
    context: { channel?: string; accountId?: string } = {}
  ): Promise<OutboundText> {
    if (!this.settings.outboundEnabled) return { send: text, original: text }
    try {
      const translateContext = { ...context, direction: 'out' as const, requestId: randomUUID() }
      const result = await this.translator.translate(text, targetLang, translateContext)
      if (result.text === text) return { send: text, original: text }
      await this.recordUsage(text, result.metered, translateContext)
      return { send: result.text, original: text, engine: this.translator.name }
    } catch {
      return {
        send: text,
        original: text,
        error: '翻译服务暂不可用，请稍后重试或在设置中切换翻译引擎。'
      }
    }
  }

  private async recordUsage(
    source: string,
    alreadyMetered: boolean | undefined,
    context: { channel?: string; accountId?: string; direction: 'in' | 'out'; requestId?: string }
  ): Promise<void> {
    if (alreadyMetered || !this.usageRecorder) return
    const characters = Array.from(source).length
    if (characters <= 0) return
    await this.usageRecorder({
      requestId: context.requestId ?? randomUUID(),
      characters,
      engine: this.translator.name,
      ...context
    })
  }
}

/** 平台断线重投同一条来信时产生相同计费键；只存摘要，不暴露聊天内容。 */
function stableInboundRequestId(msg: UnifiedMessage): string {
  const identity = msg.externalId || msg.id
  const digest = createHash('sha256')
    .update(`${msg.channel}\0${msg.accountId}\0${msg.conversationId}\0${identity}`)
    .digest('hex')
  return `in:${digest}`
}

/** 引擎返回的源语言标准化（如 google 的 zh-CN/zh、deepl 的 EN → en）；'und'/'auto' 视为未识别 */
function normalizeDetectedLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const lower = lang.toLowerCase()
  if (lower === 'und' || lower === 'auto') return undefined
  if (lower === 'zh' || lower === 'zh-cn') return 'zh-CN'
  if (lower === 'zh-tw' || lower === 'zh-hant') return 'zh-TW'
  return lower
}
