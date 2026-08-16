import { describe, expect, it } from 'vitest'
import { AiServerTranslator } from './ai-server'
import type { Translator } from '../translator'

const fallback: Translator = {
  name: 'free',
  translate: async (text) => ({ text: `FREE:${text}` })
}

function fetchWith(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status < 400,
    status,
    json: async () => body
  })) as unknown as typeof fetch
}

function make(status: number, body: unknown, backend = { serverUrl: 'https://b', token: 't' }) {
  return new AiServerTranslator({
    getBackend: () => backend,
    fallback,
    fetchImpl: fetchWith(status, body)
  })
}

describe('AiServerTranslator', () => {
  it('成功时返回后台译文', async () => {
    const r = await make(200, { text: 'HELLO' }).translate('你好', 'en')
    expect(r.text).toBe('HELLO')
  })

  it('未登录后台直接走免费引擎', async () => {
    const t = make(200, {}, { serverUrl: '', token: '' })
    expect((await t.translate('你好', 'en')).text).toBe('FREE:你好')
  })

  it('402 积分不足 → 回落免费引擎', async () => {
    const r = await make(402, { error: '积分不足' }).translate('你好', 'en')
    expect(r.text).toBe('FREE:你好')
  })

  it('501 未配模型 → 回落免费引擎', async () => {
    const r = await make(501, {}).translate('你好', 'en')
    expect(r.text).toBe('FREE:你好')
  })

  it('402 后进入冷却：后续请求不再打后台', async () => {
    let calls = 0
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: 'https://b', token: 't' }),
      fallback,
      fetchImpl: (async () => {
        calls++
        return { ok: false, status: 402, json: async () => ({}) }
      }) as unknown as typeof fetch
    })
    await t.translate('a', 'en')
    await t.translate('b', 'en')
    await t.translate('c', 'en')
    expect(calls).toBe(1)
  })

  it('网络异常回落且不抛错', async () => {
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: 'https://b', token: 't' }),
      fallback,
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
    })
    expect((await t.translate('你好', 'en')).text).toBe('FREE:你好')
  })

  it('没有降级引擎时原样返回，不拦住消息', async () => {
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: '', token: '' }),
      fetchImpl: fetchWith(200, {})
    })
    expect((await t.translate('原文', 'en')).text).toBe('原文')
  })
})
