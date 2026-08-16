import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildChatRequest,
  maskApiKey,
  parseChatResponse,
  parseErrorMessage,
  type ProviderConfig
} from '../src/ai/protocols.ts'

const input = {
  model: 'm1',
  messages: [{ role: 'user' as const, content: '你好' }],
  system: '你是客服'
}

describe('OpenAI 协议', () => {
  const config: ProviderConfig = { type: 'openai', apiKey: 'sk-test' }

  test('走 /chat/completions，Bearer 鉴权', () => {
    const r = buildChatRequest(config, input)
    assert.equal(r.url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(r.headers.authorization, 'Bearer sk-test')
  })

  test('system 作为一条 message 排在最前', () => {
    const r = buildChatRequest(config, input)
    const msgs = r.body.messages as Array<{ role: string; content: string }>
    assert.equal(msgs[0]!.role, 'system')
    assert.equal(msgs[1]!.role, 'user')
  })

  test('自定义 baseUrl 覆盖默认地址，且不产生双斜杠', () => {
    const r = buildChatRequest({ ...config, baseUrl: 'https://relay.example.com/v1/' }, input)
    assert.equal(r.url, 'https://relay.example.com/v1/chat/completions')
  })

  test('解析文本与 token 用量', () => {
    const r = parseChatResponse('openai', {
      choices: [{ message: { content: '你好呀' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 }
    })
    assert.equal(r.text, '你好呀')
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 34 })
  })
})

describe('Anthropic 协议', () => {
  const config: ProviderConfig = { type: 'anthropic', apiKey: 'sk-ant' }

  test('走 /v1/messages，用 x-api-key 且必须带版本头', () => {
    const r = buildChatRequest(config, input)
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(r.headers['x-api-key'], 'sk-ant')
    assert.equal(r.headers['anthropic-version'], '2023-06-01')
    assert.equal(r.headers.authorization, undefined, '不该带 Bearer')
  })

  test('system 是顶层字段，不能塞进 messages', () => {
    const r = buildChatRequest(config, input)
    assert.equal(r.body.system, '你是客服')
    const msgs = r.body.messages as Array<{ role: string }>
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0]!.role, 'user')
  })

  test('max_tokens 必填，有默认值', () => {
    assert.equal(buildChatRequest(config, input).body.max_tokens, 1024)
    assert.equal(buildChatRequest(config, { ...input, maxTokens: 50 }).body.max_tokens, 50)
  })

  test('解析 content 块与 input/output_tokens（字段名与 OpenAI 完全不同）', () => {
    const r = parseChatResponse('anthropic', {
      content: [{ type: 'text', text: '你好' }, { type: 'text', text: '呀' }],
      usage: { input_tokens: 12, output_tokens: 34 }
    })
    assert.equal(r.text, '你好呀')
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 34 })
  })

  test('忽略非文本块（如 tool_use）', () => {
    const r = parseChatResponse('anthropic', {
      content: [{ type: 'tool_use', id: 'x' }, { type: 'text', text: 'ok' }]
    })
    assert.equal(r.text, 'ok')
  })
})

describe('OpenRouter 协议', () => {
  const config: ProviderConfig = { type: 'openrouter', apiKey: 'sk-or' }

  test('OpenAI 兼容，但额外带来源归属头', () => {
    const r = buildChatRequest(config, input)
    assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(r.headers.authorization, 'Bearer sk-or')
    assert.ok(r.headers['http-referer'])
    assert.ok(r.headers['x-title'])
  })

  test('用量按 OpenAI 字段解析', () => {
    const r = parseChatResponse('openrouter', {
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 5, completion_tokens: 6 }
    })
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 6 })
  })
})

describe('响应解析的健壮性', () => {
  test('缺 usage 时按 0 计，不抛错（部分中转不回 usage）', () => {
    const r = parseChatResponse('openai', { choices: [{ message: { content: 'x' } }] })
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0 })
  })

  test('空响应 / null / 乱结构都不抛错', () => {
    for (const bad of [null, undefined, {}, { choices: [] }, { choices: 'x' }]) {
      const r = parseChatResponse('openai', bad)
      assert.equal(r.text, '')
      assert.equal(r.usage.inputTokens, 0)
    }
  })

  test('负数或非数字用量归零，不会算出负积分', () => {
    const r = parseChatResponse('openai', { usage: { prompt_tokens: -5, completion_tokens: 'x' } })
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0 })
  })

  test('小数 token 向下取整', () => {
    const r = parseChatResponse('openai', { usage: { prompt_tokens: 10.9 } })
    assert.equal(r.usage.inputTokens, 10)
  })
})

describe('错误信息提取', () => {
  test('三家的错误结构都能提取出人话', () => {
    assert.equal(parseErrorMessage({ error: { message: '额度不足' } }, 400), '额度不足')
    assert.equal(parseErrorMessage({ error: 'bad key' }, 401), 'bad key')
    assert.equal(parseErrorMessage({ message: 'oops' }, 500), 'oops')
  })
  test('认不出来时退回状态码，不返回 [object Object]', () => {
    assert.equal(parseErrorMessage({ weird: 1 }, 502), 'HTTP 502')
    assert.equal(parseErrorMessage(null, 500), 'HTTP 500')
  })
})

describe('API Key 打码', () => {
  test('保留首尾便于辨认，中间打码', () => {
    const masked = maskApiKey('sk-1234567890abcdef')
    assert.ok(!masked.includes('234567890abc'))
    assert.ok(masked.startsWith('sk-1'))
    assert.ok(masked.endsWith('cdef'))
  })
  test('短密钥整体打码，不泄露长度信息以外的内容', () => {
    assert.equal(maskApiKey('short'), '****')
  })
  test('空值不报错', () => {
    assert.equal(maskApiKey(''), '')
  })
})
