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
    const r = await make(200, { text: 'HELLO', metered: true }).translate('你好', 'en')
    expect(r.text).toBe('HELLO')
    expect(r.metered).toBe(true)
  })

  it('未登录后台直接走免费引擎', async () => {
    const t = make(200, {}, { serverUrl: '', token: '' })
    expect((await t.translate('你好', 'en')).text).toBe('FREE:你好')
  })

  it('402 字符不足 → 回落免费引擎', async () => {
    const r = await make(402, { error: '字符不足' }).translate('你好', 'en')
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

  it('瞬时网络错误不进冷却：下次仍尝试后台，网络恢复即刻用回 AI', async () => {
    // 只有 402/501(积分/配置类)才冷却 5 分钟；网络抖动只降级本次，绝不能把付费用户
    // 因一次瞬时失败拖进 5 分钟降级。这里第一次抛错、第二次成功，断言第二次确实又打了后台。
    let calls = 0
    let failFirst = true
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: 'https://b', token: 't' }),
      fallback,
      fetchImpl: (async () => {
        calls++
        if (failFirst) {
          failFirst = false
          throw new Error('blip')
        }
        return { ok: true, status: 200, json: async () => ({ text: 'RECOVERED' }) }
      }) as unknown as typeof fetch
    })
    expect((await t.translate('a', 'en')).text).toBe('FREE:a') // 瞬时失败 → 本次降级
    expect((await t.translate('b', 'en')).text).toBe('RECOVERED') // 未冷却 → 立刻恢复用后台
    expect(calls).toBe(2) // 第二次确实又打了后台，没被冷却跳过
  })

  it('500 服务器错误也不进冷却（冷却只由 402/501 触发）', async () => {
    let n = 0
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: 'https://b', token: 't' }),
      fallback,
      fetchImpl: (async () => {
        n++
        return n === 1
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ text: 'OK' }) }
      }) as unknown as typeof fetch
    })
    expect((await t.translate('a', 'en')).text).toBe('FREE:a') // 500 → 降级本次
    expect((await t.translate('b', 'en')).text).toBe('OK') // 未冷却 → 再打后台成功
    expect(n).toBe(2)
  })

  it('没有降级引擎时原样返回，不拦住消息', async () => {
    const t = new AiServerTranslator({
      getBackend: () => ({ serverUrl: '', token: '' }),
      fetchImpl: fetchWith(200, {})
    })
    expect((await t.translate('原文', 'en')).text).toBe('原文')
  })
})
