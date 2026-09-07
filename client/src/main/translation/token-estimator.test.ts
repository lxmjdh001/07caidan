import { describe, expect, it } from 'vitest'
import { estimateTextTokens } from './token-estimator'

describe('estimateTextTokens', () => {
  it('中日韩字符按单字估算，拉丁与 emoji 按 UTF-8 bytes 估算', () => {
    expect(estimateTextTokens('你好')).toBe(2)
    expect(estimateTextTokens('hello world')).toBe(3)
    expect(estimateTextTokens('A😀b')).toBe(2)
  })

  it('空文本为 0，非空至少 1', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('a')).toBe(1)
  })
})
