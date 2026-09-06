import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { AiRepo, type AiModel, type AiProvider } from '../src/ai/ai-repo.ts'
import { BillingRepo } from '../src/billing/billing-repo.ts'
import { openDb } from '../src/db.ts'

const T = 'tenant-1'
const U = 5
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0)

let dir: string
let billing: BillingRepo
let ai: AiRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-ai-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  billing = new BillingRepo(db)
  ai = new AiRepo(db, billing)
})

function provider(o: Partial<Parameters<AiRepo['createProvider']>[1]> = {}): AiProvider {
  const p = ai.createProvider(T, {
    type: 'openai',
    name: 'OpenAI',
    apiKey: 'sk-1234567890abcdef',
    ...o
  })
  assert.ok(p)
  return p
}

function model(providerId: string, o: Partial<Parameters<AiRepo['createModel']>[1]> = {}): AiModel {
  return ai.createModel(T, {
    providerId,
    modelName: 'gpt-4o-mini',
    purposes: ['translate'],
    creditsPerMillionInput: 300,
    creditsPerMillionOutput: 1500,
    ...o
  })
}

describe('供应商管理', () => {
  test('创建后 API Key 只以打码形式返回', () => {
    const p = provider()
    assert.ok(!p.apiKeyMasked.includes('234567890abc'), '不得泄露明文')
    assert.ok(p.apiKeyMasked.startsWith('sk-1'))
    // 列表接口同样不能吐明文
    assert.ok(!JSON.stringify(ai.listProviders(T)).includes('sk-1234567890abcdef'))
  })

  test('内部取配置时才拿得到明文', () => {
    const p = provider()
    assert.equal(ai.providerConfig(T, p.id)?.apiKey, 'sk-1234567890abcdef')
  })

  test('停用的供应商取不到配置', () => {
    const p = provider()
    ai.updateProvider(T, p.id, { enabled: false })
    assert.equal(ai.providerConfig(T, p.id), null)
  })

  test('非法协议类型被拒', () => {
    assert.equal(ai.createProvider(T, { type: 'gemini_x', name: 'x' }), null)
  })

  test('三类协议都能创建', () => {
    for (const type of ['openai', 'anthropic', 'openrouter', 'openai_compatible']) {
      assert.ok(ai.createProvider(T, { type, name: type }), type)
    }
    assert.equal(ai.listProviders(T).length, 4)
  })

  test('编辑时留空密钥表示不修改 —— 否则改个名字就把密钥清了', () => {
    const p = provider()
    ai.updateProvider(T, p.id, { name: '改名', apiKey: '' })
    assert.equal(ai.providerConfig(T, p.id)?.apiKey, 'sk-1234567890abcdef')
    assert.equal(ai.listProviders(T)[0]!.name, '改名')
  })

  test('传了新密钥则覆盖', () => {
    const p = provider()
    ai.updateProvider(T, p.id, { apiKey: 'sk-new' })
    assert.equal(ai.providerConfig(T, p.id)?.apiKey, 'sk-new')
  })

  test('删除供应商会连带删掉其下模型', () => {
    const p = provider()
    model(p.id)
    ai.deleteProvider(T, p.id)
    assert.equal(ai.listModels(T).length, 0)
  })

  test('租户隔离', () => {
    provider()
    assert.equal(ai.listProviders('other').length, 0)
  })
})

describe('模型管理', () => {
  test('用途白名单过滤，脏值不会落库', () => {
    const p = provider()
    const m = model(p.id, { purposes: ['translate', 'mining', 'asr'] })
    assert.deepEqual(m.purposes, ['translate', 'asr'])
  })

  test('按用途筛选', () => {
    const p = provider()
    model(p.id, { purposes: ['translate'] })
    model(p.id, { purposes: ['asr'], modelName: 'whisper' })
    assert.equal(ai.listModels(T, { purpose: 'asr' }).length, 1)
    assert.equal(ai.listModels(T, { purpose: 'translate' }).length, 1)
    assert.equal(ai.listModels(T, { purpose: 'autoreply' }).length, 0)
  })

  test('负单价被规整为 0', () => {
    const p = provider()
    const m = model(p.id, { creditsPerMillionInput: -5 })
    assert.equal(m.creditsPerMillionInput, 0)
  })

  test('损坏的 purposes JSON 不会让列表接口挂掉', () => {
    const p = provider()
    const m = model(p.id)
    // 直接改成坏数据，模拟人工误操作
    ai.updateModel(T, m.id, { purposes: ['translate'] })
    assert.deepEqual(ai.getModel(T, m.id)?.purposes, ['translate'])
  })
})

describe('计费参数', () => {
  test('默认积分与翻译字符兑换比例正确', () => {
    assert.deepEqual(ai.getSettings(T), {
      creditsPerUsd: 1000,
      autoTopUpCredits: true,
      charactersPerUsd: 10000
    })
  })

  test('可修改并持久化', () => {
    ai.updateSettings(T, { creditsPerUsd: 500, autoTopUpCredits: false, charactersPerUsd: 20000 })
    assert.deepEqual(ai.getSettings(T), {
      creditsPerUsd: 500,
      autoTopUpCredits: false,
      charactersPerUsd: 20000
    })
  })

  test('兑换比例至少为 1，防止除零', () => {
    ai.updateSettings(T, { creditsPerUsd: 0, charactersPerUsd: 0 })
    assert.equal(ai.getSettings(T).creditsPerUsd, 1)
    assert.equal(ai.getSettings(T).charactersPerUsd, 1)
  })
})

describe('用量计费', () => {
  test('预估不落库、不扣费', () => {
    const p = provider()
    const m = model(p.id)
    assert.equal(ai.estimate(T, m.id, { inputTokens: 1_000_000 }), 300)
    assert.equal(ai.listUsage(T, U).length, 0)
    assert.equal(billing.getBalance(T, U).credits, 0)
  })

  test('积分够时扣积分并记用量', () => {
    const p = provider()
    const m = model(p.id)
    billing.mutate(T, { userId: U, kind: 'adjust', creditsDelta: 1000, now: NOW })

    const r = ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.credits, 300)
    assert.equal(billing.getBalance(T, U).credits, 700)
    const usage = ai.listUsage(T, U)
    assert.equal(usage.length, 1)
    assert.equal(usage[0]!.credits, 300)
    assert.equal(usage[0]!.purpose, 'translate')
  })

  test('积分不足时自动从余额兑换', () => {
    const p = provider()
    const m = model(p.id)
    billing.mutate(T, { userId: U, kind: 'topup', amountCents: 10000, now: NOW })

    const r = ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    assert.equal(r.ok, true)
    // 300 积分 = $0.30 = 30 美分
    assert.equal(billing.getBalance(T, U).balanceCents, 9970)
  })

  test('钱和积分都不够 → 不扣费，也不写用量记录', () => {
    const p = provider()
    const m = model(p.id)
    const r = ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'insufficient_balance')
    assert.equal(ai.listUsage(T, U).length, 0, '没人买单的用量不该被记下来')
    assert.equal(billing.listLedger(T, U).length, 0)
  })

  test('关掉自动补足后，余额再多也不动', () => {
    const p = provider()
    const m = model(p.id)
    ai.updateSettings(T, { autoTopUpCredits: false })
    billing.mutate(T, { userId: U, kind: 'topup', amountCents: 100000, now: NOW })

    const r = ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'insufficient_credits')
    assert.equal(billing.getBalance(T, U).balanceCents, 100000)
  })

  test('停用的模型不能计费', () => {
    const p = provider()
    const m = model(p.id, { enabled: false })
    const r = ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 100 }, NOW)
    assert.equal(r.ok === false && r.reason, 'model_disabled')
  })

  test('不存在的模型', () => {
    const r = ai.chargeUsage(T, U, 'nope', 'translate', { inputTokens: 100 }, NOW)
    assert.equal(r.ok === false && r.reason, 'model_not_found')
  })

  test('零用量不扣费（调用失败的场景）', () => {
    const p = provider()
    const m = model(p.id)
    const r = ai.chargeUsage(T, U, m.id, 'translate', {}, NOW)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.credits, 0)
  })

  test('语音识别按秒计费', () => {
    const p = provider()
    const m = model(p.id, {
      purposes: ['asr'],
      creditsPerMillionInput: 0,
      creditsPerMillionOutput: 0,
      creditsPerAudioSecond: 2
    })
    billing.mutate(T, { userId: U, kind: 'adjust', creditsDelta: 1000, now: NOW })
    const r = ai.chargeUsage(T, U, m.id, 'asr', { audioSeconds: 15 }, NOW)
    assert.equal(r.ok && r.credits, 30)
    assert.equal(ai.listUsage(T, U)[0]!.audioSeconds, 15)
  })

  test('用量汇总按模型与用途分组', () => {
    const p = provider()
    const a = model(p.id, { purposes: ['translate'] })
    const b = model(p.id, { purposes: ['asr'], creditsPerAudioSecond: 1 })
    billing.mutate(T, { userId: U, kind: 'adjust', creditsDelta: 100000, now: NOW })

    ai.chargeUsage(T, U, a.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    ai.chargeUsage(T, U, a.id, 'translate', { inputTokens: 1_000_000 }, NOW)
    ai.chargeUsage(T, U, b.id, 'asr', { audioSeconds: 10 }, NOW)

    const summary = ai.usageSummary(T, { userId: U })
    const translate = summary.find((s) => s.modelId === a.id)
    assert.equal(translate?.calls, 2)
    assert.equal(translate?.credits, 600)
    assert.equal(summary.find((s) => s.modelId === b.id)?.credits, 10)
  })

  test('计费后账仍然是平的', () => {
    const p = provider()
    const m = model(p.id)
    billing.mutate(T, { userId: U, kind: 'topup', amountCents: 10000, now: NOW })
    ai.chargeUsage(T, U, m.id, 'translate', { inputTokens: 500_000 }, NOW)
    ai.chargeUsage(T, U, m.id, 'translate', { outputTokens: 200_000 }, NOW)
    assert.equal(billing.auditBalance(T, U).consistent, true)
  })
})
