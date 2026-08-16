import type { TokenUsage } from '../billing/credits.ts'
import {
  DEFAULT_BASE_URL,
  buildChatRequest,
  parseChatResponse,
  parseErrorMessage,
  type ChatRequestInput,
  type ProviderConfig
} from './protocols.ts'

/** 可注入的 fetch，测试里换成假实现，绝不真调供应商 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | Uint8Array }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface ChatOutcome {
  ok: boolean
  text: string
  usage: TokenUsage
  error?: string
}

/**
 * 真正发请求的 AI 客户端。
 * 协议构造/解析在 protocols.ts（纯函数），这里只做网络与超时。
 */
export class AiClient {
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(fetchImpl?: FetchLike, timeoutMs = 60_000) {
    this.fetchImpl =
      fetchImpl ??
      (async (url, init) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          const res = await fetch(url, { ...init, signal: controller.signal })
          return { ok: res.ok, status: res.status, json: () => res.json() }
        } finally {
          clearTimeout(timer)
        }
      })
    this.timeoutMs = timeoutMs
  }

  /**
   * 语音识别（whisper 风格 /audio/transcriptions）。
   * Anthropic 没有 ASR 端点，路由层会提前拦掉。
   */
  async transcribe(config: ProviderConfig, input: AsrInput): Promise<AsrOutcome> {
    const base = (config.baseUrl || DEFAULT_BASE_URL[config.type] || '').replace(/\/+$/, '')
    const { contentType, body } = buildAsrBody(input)
    try {
      const res = await this.fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': contentType
        },
        body
      })
      const json = (await res.json().catch(() => ({}))) as { text?: string }
      if (!res.ok) return { ok: false, text: '', error: parseErrorMessage(json, res.status) }
      return { ok: true, text: typeof json.text === 'string' ? json.text : '' }
    } catch (err) {
      return { ok: false, text: '', error: String(err) }
    }
  }

  async chat(config: ProviderConfig, input: ChatRequestInput): Promise<ChatOutcome> {
    const req = buildChatRequest(config, input)
    try {
      const res = await this.fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body)
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        return {
          ok: false,
          text: '',
          usage: {},
          error: parseErrorMessage(json, res.status)
        }
      }
      const parsed = parseChatResponse(config.type, json)
      return { ok: true, ...parsed }
    } catch (err) {
      return { ok: false, text: '', usage: {}, error: String(err) }
    }
  }
}

export interface AsrInput {
  modelName: string
  audio: Uint8Array
  mimeType: string
  fileName?: string
  /** 提示语言可提高识别准确率；可选 */
  language?: string
}

export interface AsrOutcome {
  ok: boolean
  text: string
  error?: string
}

/** multipart 边界：固定值即可，正文里出现同串的概率可忽略 */
const BOUNDARY = '----omnichat-asr-7f3d9c'

/**
 * 构造 whisper 风格 /audio/transcriptions 的 multipart 请求体。
 * 拆成纯函数便于单测（校验字段与二进制完整性，不发网络）。
 */
export function buildAsrBody(input: AsrInput): { contentType: string; body: Uint8Array } {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const field = (name: string, value: string): void => {
    parts.push(
      enc.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    )
  }
  field('model', input.modelName)
  if (input.language) field('language', input.language)
  parts.push(
    enc.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName ?? 'audio.ogg'}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`
    )
  )
  parts.push(input.audio)
  parts.push(enc.encode(`\r\n--${BOUNDARY}--\r\n`))

  const total = parts.reduce((n, p) => n + p.length, 0)
  const body = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    body.set(p, off)
    off += p.length
  }
  return { contentType: `multipart/form-data; boundary=${BOUNDARY}`, body }
}

/** 翻译提示词：只回译文，不做解释 —— 多一句话都会进聊天窗口 */
export function translatePrompt(targetLang: string): string {
  return (
    `You are a translation engine. Translate the user message into ${targetLang}. ` +
    'Output ONLY the translation, with no explanations, notes, or quotation marks. ' +
    'Preserve emoji, numbers, and formatting.'
  )
}
