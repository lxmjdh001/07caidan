import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  calculateBilledTokens,
  estimateTextTokens,
  normalizeTranslationTokenRates
} from '../src/billing/translation-tokens.ts'

describe('翻译 Token 计费', () => {
  test('自建 Google 默认费率比其他引擎低', () => {
    const rates = normalizeTranslationTokenRates(undefined)
    assert.equal(calculateBilledTokens(10, 10, rates['google-free']!), 4)
    assert.equal(calculateBilledTokens(10, 10, rates.deepl!), 20)
  })

  test('短文本至少扣 1 Token，空文本不扣', () => {
    const rate = { inputRateBps: 1000, outputRateBps: 1000 }
    assert.equal(calculateBilledTokens(1, 0, rate), 1)
    assert.equal(calculateBilledTokens(0, 0, rate), 0)
  })

  test('无真实 usage 时可在服务端隐私估算', () => {
    assert.equal(estimateTextTokens('你好'), 2)
    assert.equal(estimateTextTokens('hello world'), 3)
  })
})
