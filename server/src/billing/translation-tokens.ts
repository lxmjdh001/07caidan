export interface TranslationTokenRate {
  inputRateBps: number
  outputRateBps: number
}

export type TranslationTokenRates = Record<string, TranslationTokenRate>

/** 10000 = 每个实际 Token 扣 1 个 Token 额度。自建 Google 默认按 0.2 倍计费。 */
export const DEFAULT_TRANSLATION_TOKEN_RATES: TranslationTokenRates = {
  'google-free': { inputRateBps: 2000, outputRateBps: 2000 },
  deepl: { inputRateBps: 10000, outputRateBps: 10000 },
  'google-cloud': { inputRateBps: 10000, outputRateBps: 10000 },
  llm: { inputRateBps: 10000, outputRateBps: 10000 },
  'custom-http': { inputRateBps: 10000, outputRateBps: 10000 },
  'ai-server': { inputRateBps: 10000, outputRateBps: 10000 }
}

export function normalizeTranslationTokenRates(value: unknown): TranslationTokenRates {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const normalized: TranslationTokenRates = {}
  for (const [engine, fallback] of Object.entries(DEFAULT_TRANSLATION_TOKEN_RATES)) {
    const current = source[engine] && typeof source[engine] === 'object'
      ? source[engine] as Partial<TranslationTokenRate>
      : {}
    normalized[engine] = {
      inputRateBps: validRate(current.inputRateBps, fallback.inputRateBps),
      outputRateBps: validRate(current.outputRateBps, fallback.outputRateBps)
    }
  }
  return normalized
}

export function calculateBilledTokens(
  inputTokens: number,
  outputTokens: number,
  rate: TranslationTokenRate
): number {
  const input = Math.max(0, Math.floor(Number(inputTokens) || 0))
  const output = Math.max(0, Math.floor(Number(outputTokens) || 0))
  if (input + output === 0) return 0
  return Math.max(1, Math.ceil((input * rate.inputRateBps + output * rate.outputRateBps) / 10000))
}

/** 与客户端相同的隐私友好估算；服务端 AI 无 usage 时兜底使用。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let otherBytes = 0
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk++
    else otherBytes += Buffer.byteLength(char, 'utf8')
  }
  const estimated = cjk + Math.ceil(otherBytes / 4)
  return text.length > 0 ? Math.max(1, estimated) : 0
}

function validRate(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : fallback
}
