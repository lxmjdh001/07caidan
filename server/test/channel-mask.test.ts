import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { maskChannelConfig } from '../src/billing/channel-repo.ts'

// maskChannelConfig 决定哪些通道配置键算「密钥」而打码回传。只有 e2e 端点测过，
// 函数本身没测。钉死密钥键集：若日后有人从 SECRET_KEYS 里漏掉一个，这里会红——
// 否则该密钥会明文回传到前端/接口（泄密）。
describe('maskChannelConfig', () => {
  test('每个密钥键都打码，非密钥键原样透传', () => {
    const masked = maskChannelConfig({
      apiKey: 'sk-SECRET', key: 'k-SECRET', clientSecret: 'cs-SECRET',
      callbackSecret: 'cb-SECRET', webhookId: 'wh-SECRET',
      name: '通道A', endpoint: 'https://pay.example', mode: 'live'
    })
    for (const k of ['apiKey', 'key', 'clientSecret', 'callbackSecret', 'webhookId']) {
      assert.equal(masked[k], '••••••', `${k} 必须打码`)
    }
    // 非密钥原样
    assert.equal(masked.name, '通道A')
    assert.equal(masked.endpoint, 'https://pay.example')
    assert.equal(masked.mode, 'live')
    // 整体绝无任何密钥原文
    const raw = JSON.stringify(masked)
    for (const s of ['sk-SECRET', 'k-SECRET', 'cs-SECRET', 'cb-SECRET', 'wh-SECRET']) {
      assert.equal(raw.includes(s), false, `不得泄露 ${s}`)
    }
  })

  test('空密钥值保持空（便于前端区分「未配置」与「已配置已打码」）', () => {
    const masked = maskChannelConfig({ apiKey: '', name: 'x' })
    assert.equal(masked.apiKey, '') // 空值不打码
    assert.equal(masked.name, 'x')
  })
})
