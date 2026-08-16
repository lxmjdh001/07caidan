import type { TokenUsage } from '../billing/credits.ts'

/**
 * 三类 AI 协议的请求构造与响应解析。
 *
 * 做成**纯函数**（不发网络请求）是刻意的：计费依赖于从响应里正确读出
 * token 用量，而三家的字段名完全不同，读错就直接算错钱。纯函数才能
 * 脱离网络把每种响应形状都测一遍。
 *
 * 三者的真实差异：
 * - OpenAI：POST {base}/chat/completions，Bearer 鉴权，
 *   用量在 usage.prompt_tokens / completion_tokens
 * - Anthropic：POST {base}/v1/messages，x-api-key + anthropic-version 头，
 *   system 是**顶层字段**而不是一条 message，
 *   用量在 usage.input_tokens / output_tokens
 * - OpenRouter：OpenAI 兼容，但建议带 HTTP-Referer / X-Title 头做用量归属
 */

export type ProviderType = 'openai' | 'anthropic' | 'openrouter' | 'openai_compatible'

export const PROVIDER_TYPES: ProviderType[] = [
  'openai',
  'anthropic',
  'openrouter',
  'openai_compatible'
]

export function isProviderType(v: string): v is ProviderType {
  return (PROVIDER_TYPES as string[]).includes(v)
}

/** 各协议的默认入口；自定义 baseUrl 时以用户填的为准 */
export const DEFAULT_BASE_URL: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai_compatible: ''
}

/** Anthropic 要求带版本头，写死在这里避免各处漏传 */
const ANTHROPIC_VERSION = '2023-06-01'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequestInput {
  model: string
  messages: ChatMessage[]
  /** 系统提示；Anthropic 走顶层字段，OpenAI 系走 system 角色消息 */
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface ProviderConfig {
  type: ProviderType
  baseUrl?: string
  apiKey: string
}

export interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function base(config: ProviderConfig): string {
  const b = (config.baseUrl || DEFAULT_BASE_URL[config.type] || '').replace(/\/+$/, '')
  return b
}

/** 构造一次对话请求 */
export function buildChatRequest(config: ProviderConfig, input: ChatRequestInput): HttpRequest {
  const maxTokens = input.maxTokens ?? 1024

  if (config.type === 'anthropic') {
    return {
      url: `${base(config)}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: {
        model: input.model,
        max_tokens: maxTokens,
        // Anthropic 的 system 是顶层字段，塞进 messages 会被拒
        ...(input.system ? { system: input.system } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        messages: input.messages
      }
    }
  }

  // OpenAI / OpenRouter / 兼容网关
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`
  }
  if (config.type === 'openrouter') {
    // OpenRouter 用这两个头做调用来源归属，缺了不影响功能但后台看不到来源
    headers['http-referer'] = 'https://omnichat.app'
    headers['x-title'] = 'OmniChat'
  }

  const messages = input.system
    ? [{ role: 'system', content: input.system }, ...input.messages]
    : input.messages

  return {
    url: `${base(config)}/chat/completions`,
    headers,
    body: {
      model: input.model,
      messages,
      max_tokens: maxTokens,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {})
    }
  }
}

export interface ChatResult {
  text: string
  usage: TokenUsage
}

/**
 * 解析响应，取出文本与 token 用量。
 *
 * 用量字段缺失时返回 0 而不是抛错 —— 有些中转网关不回 usage，
 * 这时按 0 计费总比让整条消息发不出去好；漏计的成本由运营方承担，
 * 但可以通过「最低消费」兜底。
 */
export function parseChatResponse(type: ProviderType, json: unknown): ChatResult {
  const o = (json ?? {}) as Record<string, any>

  if (type === 'anthropic') {
    const blocks = Array.isArray(o.content) ? o.content : []
    const text = blocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
    return {
      text,
      usage: {
        inputTokens: num(o.usage?.input_tokens),
        outputTokens: num(o.usage?.output_tokens)
      }
    }
  }

  const choice = Array.isArray(o.choices) ? o.choices[0] : undefined
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  return {
    text,
    usage: {
      inputTokens: num(o.usage?.prompt_tokens ?? o.usage?.input_tokens),
      outputTokens: num(o.usage?.completion_tokens ?? o.usage?.output_tokens)
    }
  }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 从响应里提取错误信息。三家的错误结构又不一样，
 * 统一成一句人话，否则前端只能展示 "[object Object]"。
 */
export function parseErrorMessage(json: unknown, status: number): string {
  const o = (json ?? {}) as Record<string, any>
  const msg =
    (typeof o.error === 'string' ? o.error : undefined) ??
    o.error?.message ??
    o.message ??
    o.detail
  return typeof msg === 'string' && msg ? msg : `HTTP ${status}`
}

/** API Key 打码，用于回给管理后台展示；绝不能把明文吐出去 */
export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}${'*'.repeat(6)}${key.slice(-4)}`
}
