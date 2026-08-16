import { describe, expect, it } from 'vitest'
import { hasApiApp, resolveApiApp } from './api-app'

const BUILTIN = { apiId: '111', apiHash: 'builtin-hash' }

describe('resolveApiApp', () => {
  it('普通用户什么都不填 → 用软件内置凭证', () => {
    expect(resolveApiApp({}, {}, BUILTIN)).toEqual({ apiId: 111, apiHash: 'builtin-hash' })
  })

  it('全局设置覆盖内置', () => {
    expect(resolveApiApp({}, { telegramApiId: '222', telegramApiHash: 'g' }, BUILTIN)).toEqual({
      apiId: 222,
      apiHash: 'g'
    })
  })

  it('账号级覆盖优先级最高', () => {
    const r = resolveApiApp(
      { apiId: '333', apiHash: 'a' },
      { telegramApiId: '222', telegramApiHash: 'g' },
      BUILTIN
    )
    expect(r).toEqual({ apiId: 333, apiHash: 'a' })
  })

  it('id 和 hash 各自独立回落', () => {
    const r = resolveApiApp({ apiHash: 'only-hash' }, {}, BUILTIN)
    expect(r).toEqual({ apiId: 111, apiHash: 'only-hash' })
  })

  it('空白字符串当作没填', () => {
    expect(resolveApiApp({ apiId: '  ', apiHash: ' ' }, {}, BUILTIN).apiId).toBe(111)
  })

  it('非数字 api_id 视为无效而不是 NaN', () => {
    expect(resolveApiApp({ apiId: 'abc' }, {}, { apiId: '', apiHash: 'h' }).apiId).toBeUndefined()
  })

  it('没有内置也没有配置 → 两项都缺', () => {
    const r = resolveApiApp({}, {}, { apiId: '', apiHash: '' })
    expect(r).toEqual({ apiId: undefined, apiHash: undefined })
    expect(hasApiApp(r)).toBe(false)
  })

  it('只有一半凭证不算可用', () => {
    expect(hasApiApp(resolveApiApp({}, {}, { apiId: '111', apiHash: '' }))).toBe(false)
    expect(hasApiApp(resolveApiApp({}, {}, BUILTIN))).toBe(true)
  })
})
