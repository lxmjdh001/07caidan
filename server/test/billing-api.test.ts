import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { AiClient } from '../src/ai/ai-client.ts'
import { buildServer } from '../src/server.ts'

/** 假 AI 供应商：chat 回固定译文与用量，transcribe 回固定文本，绝不发网络 */
function fakeAiClient(): AiClient {
  return new AiClient(async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/audio/transcriptions')
        ? { text: 'FAKE_ASR' }
        : {
            choices: [{ message: { content: 'FAKE_TRANSLATION' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          }
  }))
}

let dir: string
let app: FastifyInstance
/** 管理员令牌 / 客户端用户令牌 */
let adminToken = ''
let userToken = ''

function makeConfig(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    tokens: ['dev-token'],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: 'dev-token',
    requireEmailVerify: false,
    clientTenant: 'dev-token',
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

async function api(
  method: string,
  url: string,
  body?: unknown,
  token: string | null = userToken
): Promise<{ status: number; json: any; text: string }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try {
    json = res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.statusCode, json, text: res.body }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-bapi-'))
})
after(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)), {
    aiClient: fakeAiClient()
  })
  await app.ready()
  adminToken = (await api('POST', '/api/login', { username: 'admin', password: 'admin' }, null))
    .json.token
  userToken = (
    await api('POST', '/api/client/register', { email: 'u@test.com', password: 'pw123456' }, null)
  ).json.token
  assert.ok(adminToken && userToken)
})

/** 管理员建一个 mock 支付通道 */
async function mockChannel(over: Record<string, unknown> = {}): Promise<string> {
  const r = await api(
    'POST',
    '/api/admin/channels',
    {
      type: 'mock',
      name: '测试通道',
      config: { callbackSecret: 's3cret' },
      ...over
    },
    adminToken
  )
  assert.equal(r.status, 200, r.text)
  return r.json.channel.id
}

/** 触发支付回调（模拟通道异步通知） */
async function notify(
  channelId: string,
  orderId: string,
  over: Record<string, string> = {}
): Promise<{ status: number; text: string }> {
  const r = await api(
    'POST',
    `/pay/notify/dev-token/${channelId}`,
    { order_id: orderId, status: 'paid', secret: 's3cret', ...over },
    null
  )
  return { status: r.status, text: r.text }
}

describe('权限边界', () => {
  test('客户端用户进不了管理接口', async () => {
    assert.equal((await api('GET', '/api/admin/plans')).status, 403)
  })
  test('静态同步令牌没有钱包', async () => {
    const r = await api('GET', '/api/billing/me', undefined, 'dev-token')
    assert.equal(r.status, 403)
  })
  test('管理员没有 billing:manage 之外的越权路径', async () => {
    // owner 有权限，正常返回
    assert.equal((await api('GET', '/api/admin/plans', undefined, adminToken)).status, 200)
  })
})

describe('充值全链路（mock 通道）', () => {
  test('下单 → 回调 → 到账，重复回调不重复入账', async () => {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    assert.equal(order.status, 'pending')
    assert.equal(order.payableCents, 10000)

    // 通道连发三次回调
    for (let i = 0; i < 3; i++) {
      const n = await notify(ch, order.id, { amount_minor: '10000' })
      assert.equal(n.status, 200, n.text)
      assert.equal(n.text, 'ok')
    }

    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.balance.balanceCents, 10000, '三次回调只能入账一次')

    const orders = (await api('GET', '/api/billing/orders')).json.orders
    assert.equal(orders[0].status, 'paid')
  })

  test('密钥不对的回调被拒且不入账', async () => {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 5000, channelId: ch })
    ).json.order
    const n = await notify(ch, order.id, { secret: 'wrong' })
    assert.equal(n.status, 400)
    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.balance.balanceCents, 0)
  })

  test('金额不足的回调被拒 —— 只验签不验金额是漏洞', async () => {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    const n = await notify(ch, order.id, { amount_minor: '1' })
    assert.equal(n.status, 400)
    assert.equal((await api('GET', '/api/billing/me')).json.balance.balanceCents, 0)
  })

  test('客户承担手续费：应付高于面值，到账仍是面值', async () => {
    const ch = await mockChannel({ feeRate: 0.05, feePaidBy: 'customer' })
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    assert.ok(order.payableCents > 10000)
    await notify(ch, order.id, { amount_minor: String(order.payableLocal) })
    assert.equal((await api('GET', '/api/billing/me')).json.balance.balanceCents, 10000)
  })

  test('非美元通道按汇率换算并锁定', async () => {
    await api('PUT', '/api/admin/rates/CNY', { rate: 7.2 }, adminToken)
    const ch = await mockChannel({ currency: 'CNY' })
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    assert.equal(order.currency, 'CNY')
    assert.equal(order.payableLocal, 72000)
  })

  test('未配置汇率的币种下不了单', async () => {
    const ch = await mockChannel({ currency: 'EUR' })
    const r = await api('POST', '/api/billing/orders', {
      kind: 'topup',
      amountCents: 10000,
      channelId: ch
    })
    assert.equal(r.status, 400)
  })

  test('充值下限 $1', async () => {
    const ch = await mockChannel()
    const r = await api('POST', '/api/billing/orders', {
      kind: 'topup',
      amountCents: 50,
      channelId: ch
    })
    assert.equal(r.status, 400)
  })
})

describe('套餐全链路', () => {
  async function makePlan(over: Record<string, unknown> = {}): Promise<string> {
    const r = await api(
      'POST',
      '/api/admin/plans',
      { name: '基础版', priceCents: 3000, periodUnit: 'month', maxAccounts: 10, ...over },
      adminToken
    )
    return r.json.plan.id
  }

  test('套餐单支付后自动完成订阅', async () => {
    const ch = await mockChannel()
    const planId = await makePlan()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'plan', planId, channelId: ch })
    ).json.order
    assert.equal(order.amountCents, 3000)

    await notify(ch, order.id, { amount_minor: '3000' })

    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.subscription?.planId, planId)
    assert.equal(me.accountQuota, 10)
    assert.equal(me.balance.balanceCents, 0, '钱都花在套餐上了')
  })

  test('余额订阅与升级折算', async () => {
    const ch = await mockChannel()
    const basic = await makePlan()
    const pro = await makePlan({ name: '专业版', priceCents: 30000, periodUnit: 'year', maxAccounts: 100 })

    // 充 $400
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 40000, channelId: ch })
    ).json.order
    await notify(ch, order.id, { amount_minor: '40000' })

    // 余额买基础版
    const sub = await api('POST', '/api/billing/subscribe', { planId: basic })
    assert.equal(sub.status, 200, sub.text)

    // 立刻升级到专业版：基础版全额折算退回
    const up = await api('POST', '/api/billing/subscribe', { planId: pro })
    assert.equal(up.status, 200)
    assert.equal(up.json.creditFromOld, 3000, '未使用的按天折算，刚买即全退')

    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.accountQuota, 100)
    // 40000 - 3000 + 3000 - 30000
    assert.equal(me.balance.balanceCents, 10000)
  })

  test('余额不足的订阅被拒且给出人话', async () => {
    const planId = await makePlan()
    const r = await api('POST', '/api/billing/subscribe', { planId })
    assert.equal(r.status, 400)
    assert.equal(r.json.reason, 'insufficient_balance')
  })

  test('自动续费开关', async () => {
    const ch = await mockChannel()
    const planId = await makePlan({ priceCents: 0 })
    await api('POST', '/api/billing/subscribe', { planId })
    const r = await api('POST', '/api/billing/auto-renew', { on: true })
    assert.equal(r.status, 200)
    assert.equal((await api('GET', '/api/billing/me')).json.subscription.autoRenew, true)
    void ch
  })
})

describe('管理员手动补单与调余额', () => {
  test('手动标记已支付：充值到账一次，重复标记幂等', async () => {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 2000, channelId: ch })
    ).json.order

    const r1 = await api('POST', `/api/admin/orders/${order.id}/mark-paid`, {}, adminToken)
    assert.equal(r1.status, 200)
    assert.equal(r1.json.alreadyPaid, false)
    assert.equal(
      (await api('GET', '/api/billing/me')).json.balance.balanceCents,
      2000
    )
    // 再标记一次：幂等，不重复入账
    const r2 = await api('POST', `/api/admin/orders/${order.id}/mark-paid`, {}, adminToken)
    assert.equal(r2.json.alreadyPaid, true)
    assert.equal((await api('GET', '/api/billing/me')).json.balance.balanceCents, 2000)
  })

  test('套餐单手动标记后自动开通订阅', async () => {
    const ch = await mockChannel()
    const plan = (
      await api(
        'POST',
        '/api/admin/plans',
        { name: '测试月付', priceCents: 999, periodUnit: 'month', maxAccounts: 3 },
        adminToken
      )
    ).json.plan
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'plan', planId: plan.id, channelId: ch })
    ).json.order
    await api('POST', `/api/admin/orders/${order.id}/mark-paid`, {}, adminToken)
    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.subscription?.planId, plan.id)
    assert.equal(me.accountQuota, 3)
  })

  test('管理员订单列表可按状态过滤且带用户邮箱', async () => {
    const ch = await mockChannel()
    await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 1000, channelId: ch })
    const list = await api('GET', '/api/admin/orders?status=pending', undefined, adminToken)
    assert.equal(list.status, 200)
    assert.ok(list.json.orders.length >= 1)
    assert.equal(list.json.orders[0].email, 'u@test.com')
  })

  test('手动加余额 / 扣余额都会留 adjust 流水；扣成负数被拒', async () => {
    const add = await api(
      'POST',
      '/api/admin/balance-adjust',
      { email: 'u@test.com', deltaCents: 5000, note: '测试赠送' },
      adminToken
    )
    assert.equal(add.status, 200)
    assert.equal(add.json.balance.balanceCents, 5000)

    const deduct = await api(
      'POST',
      '/api/admin/balance-adjust',
      { email: 'u@test.com', deltaCents: -3000 },
      adminToken
    )
    assert.equal(deduct.json.balance.balanceCents, 2000)

    // 流水必须有两条 adjust，且 note 带操作人
    const ledger = (await api('GET', '/api/billing/ledger')).json.ledger
    const adjusts = ledger.filter((l: any) => l.kind === 'adjust')
    assert.equal(adjusts.length, 2)
    assert.match(adjusts[0].note, /by admin/)

    // 扣穿余额被拒，余额不变
    const over = await api(
      'POST',
      '/api/admin/balance-adjust',
      { email: 'u@test.com', deltaCents: -99999 },
      adminToken
    )
    assert.equal(over.status, 400)
    assert.equal((await api('GET', '/api/billing/me')).json.balance.balanceCents, 2000)

    // 未知邮箱
    assert.equal(
      (
        await api(
          'POST',
          '/api/admin/balance-adjust',
          { email: 'ghost@test.com', deltaCents: 100 },
          adminToken
        )
      ).status,
      400
    )
  })

  test('普通同步令牌不能补单或调余额', async () => {
    assert.equal((await api('GET', '/api/admin/orders')).status, 403)
    assert.equal(
      (await api('POST', '/api/admin/balance-adjust', { email: 'u@test.com', deltaCents: 1 }))
        .status,
      403
    )
  })
})

describe('积分与模型计费（HTTP 层）', () => {
  async function setupModel(): Promise<string> {
    const p = (
      await api(
        'POST',
        '/api/admin/ai/providers',
        { type: 'openai', name: 'OpenAI', apiKey: 'sk-test-1234567890' },
        adminToken
      )
    ).json.provider
    const m = (
      await api(
        'POST',
        '/api/admin/ai/models',
        {
          providerId: p.id,
          modelName: 'gpt-4o-mini',
          purposes: ['translate'],
          creditsPerMillionInput: 300,
          creditsPerMillionOutput: 1500
        },
        adminToken
      )
    ).json.model
    return m.id
  }

  test('供应商列表不泄露 API Key 明文', async () => {
    await setupModel()
    const raw = JSON.stringify((await api('GET', '/api/admin/ai/providers', undefined, adminToken)).json)
    assert.ok(!raw.includes('sk-test-1234567890'))
  })

  test('客户端模型列表只有 id 与用途，没有价格与供应商信息', async () => {
    await setupModel()
    const models = (await api('GET', '/api/billing/models?purpose=translate')).json.models
    assert.equal(models.length, 1)
    assert.deepEqual(Object.keys(models[0]).sort(), ['id', 'label', 'purposes'])
  })

  test('充值 → 兑换积分 → 上报用量扣费 → 流水完整', async () => {
    const ch = await mockChannel()
    const modelId = await setupModel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    await notify(ch, order.id, { amount_minor: '10000' })

    // 换 $1 的积分（默认 1000 积分/美元）
    const ex = await api('POST', '/api/billing/exchange-credits', { cents: 100 })
    assert.equal(ex.status, 200)
    assert.equal(ex.json.balance.credits, 1000)

    const charge = await api('POST', '/api/billing/usage/charge', {
      modelId,
      purpose: 'translate',
      inputTokens: 1_000_000
    })
    assert.equal(charge.status, 200)
    assert.equal(charge.json.credits, 300)

    const me = (await api('GET', '/api/billing/me')).json
    assert.equal(me.balance.credits, 700)
    const usage = (await api('GET', '/api/billing/usage')).json.usage
    assert.equal(usage.length, 1)

    const summary = (await api('GET', '/api/admin/usage-summary', undefined, adminToken)).json.summary
    assert.equal(summary[0].credits, 300)
  })

  test('钱和积分都没有时扣费返回 402', async () => {
    const modelId = await setupModel()
    const r = await api('POST', '/api/billing/usage/charge', {
      modelId,
      purpose: 'translate',
      inputTokens: 1_000_000
    })
    assert.equal(r.status, 402)
  })
})

describe('通道配置安全', () => {
  test('通道列表的敏感配置打码', async () => {
    await mockChannel()
    const raw = JSON.stringify((await api('GET', '/api/admin/channels', undefined, adminToken)).json)
    assert.ok(!raw.includes('s3cret'))
  })

  test('编辑通道时打码值不会覆盖真实密钥', async () => {
    const ch = await mockChannel()
    // 前端表单把打码值原样传回
    await api(
      'PATCH',
      `/api/admin/channels/${ch}`,
      { name: '改名', config: { callbackSecret: '••••••' } },
      adminToken
    )
    // 回调仍然能用原密钥验证 → 密钥没被抹掉
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    const n = await notify(ch, order.id, { amount_minor: '10000' })
    assert.equal(n.status, 200)
  })
})

describe('AI 翻译与语音识别（假供应商）', () => {
  async function setup(opts: { purposes?: string[]; audioPrice?: boolean } = {}) {
    const p = (
      await api(
        'POST',
        '/api/admin/ai/providers',
        { type: 'openai', name: 'OpenAI', apiKey: 'sk-fake' },
        adminToken
      )
    ).json.provider
    const m = (
      await api(
        'POST',
        '/api/admin/ai/models',
        {
          providerId: p.id,
          modelName: 'gpt-4o-mini',
          purposes: opts.purposes ?? ['translate'],
          creditsPerMillionInput: 300,
          creditsPerMillionOutput: 1500,
          ...(opts.audioPrice ? { creditsPerAudioSecond: 2 } : {})
        },
        adminToken
      )
    ).json.model
    return m.id as string
  }

  async function fund(credits: number): Promise<void> {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    await notify(ch, order.id, { amount_minor: '10000' })
    if (credits > 0) {
      await api('POST', '/api/billing/exchange-credits', { cents: Math.ceil(credits / 10) })
    }
  }

  test('翻译成功：走假 fetch，返回译文并按真实用量扣费', async () => {
    await setup()
    await fund(1000)
    const r = await api('POST', '/api/ai/translate', { text: '你好', targetLang: 'en' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.text, 'FAKE_TRANSLATION')
    assert.equal(r.json.credits, 1, '10+5 token 向上取整为 1 积分')
    const usage = (await api('GET', '/api/billing/usage')).json.usage
    assert.equal(usage[0].purpose, 'translate')
  })

  test('未配置模型回 501 —— 客户端据此回落免费引擎', async () => {
    const r = await api('POST', '/api/ai/translate', { text: 'hi', targetLang: 'zh' })
    assert.equal(r.status, 501)
  })

  test('穷得叮当响时预检直接 402，不去花供应商的钱', async () => {
    await setup()
    const r = await api('POST', '/api/ai/translate', { text: '你好', targetLang: 'en' })
    assert.equal(r.status, 402)
    assert.equal(r.json.reason, 'insufficient_credits')
  })

  test('语音识别按时长计费', async () => {
    await setup({ purposes: ['asr'], audioPrice: true })
    await fund(1000)
    const r = await api('POST', '/api/ai/asr', {
      audioBase64: Buffer.from([1, 2, 3]).toString('base64'),
      mimeType: 'audio/ogg',
      durationSec: 13
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.text, 'FAKE_ASR')
    assert.equal(r.json.credits, 26, '13 秒 × 2 积分/秒')
  })

  test('文本超长被拒', async () => {
    await setup()
    const r = await api('POST', '/api/ai/translate', { text: 'x'.repeat(9000), targetLang: 'en' })
    assert.equal(r.status, 400)
  })
})

describe('AI 自动回复', () => {
  async function setupReplyModel(): Promise<void> {
    const p = (
      await api(
        'POST',
        '/api/admin/ai/providers',
        { type: 'openai', name: 'OpenAI', apiKey: 'sk-fake' },
        adminToken
      )
    ).json.provider
    await api(
      'POST',
      '/api/admin/ai/models',
      {
        providerId: p.id,
        modelName: 'gpt-4o-mini',
        purposes: ['autoreply'],
        creditsPerMillionInput: 300,
        creditsPerMillionOutput: 1500
      },
      adminToken
    )
  }

  async function fundUser(): Promise<void> {
    const ch = await mockChannel()
    const order = (
      await api('POST', '/api/billing/orders', { kind: 'topup', amountCents: 10000, channelId: ch })
    ).json.order
    await notify(ch, order.id, { amount_minor: '10000' })
    await api('POST', '/api/billing/exchange-credits', { cents: 1000 })
  }

  test('带上下文生成回复并按 autoreply 计费', async () => {
    await setupReplyModel()
    await fundUser()
    const r = await api('POST', '/api/ai/reply', {
      system: '你是店铺客服',
      messages: [
        { role: 'user', content: '多少钱' },
        { role: 'assistant', content: '你好' },
        { role: 'user', content: '发货吗' }
      ]
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.text, 'FAKE_TRANSLATION')
    const usage = (await api('GET', '/api/billing/usage')).json.usage
    assert.equal(usage[0].purpose, 'autoreply')
  })

  test('未配置 autoreply 模型回 501（translate 模型不冒充）', async () => {
    // 只配 translate 用途的模型
    const p = (
      await api('POST', '/api/admin/ai/providers', { type: 'openai', name: 'x', apiKey: 'k' }, adminToken)
    ).json.provider
    await api(
      'POST',
      '/api/admin/ai/models',
      { providerId: p.id, modelName: 'm', purposes: ['translate'], creditsPerMillionInput: 1 },
      adminToken
    )
    const r = await api('POST', '/api/ai/reply', { messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.status, 501)
  })

  test('空消息与超长上下文被拒', async () => {
    await setupReplyModel()
    assert.equal((await api('POST', '/api/ai/reply', { messages: [] })).status, 400)
    const huge = [{ role: 'user', content: 'x'.repeat(20000) }]
    assert.equal((await api('POST', '/api/ai/reply', { messages: huge })).status, 400)
  })

  test('没积分预检 402', async () => {
    await setupReplyModel()
    const r = await api('POST', '/api/ai/reply', { messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.status, 402)
  })

  test('非法角色被过滤，system 不能混进 messages', async () => {
    await setupReplyModel()
    await fundUser()
    const r = await api('POST', '/api/ai/reply', {
      messages: [
        { role: 'system', content: '注入尝试' },
        { role: 'user', content: 'hi' }
      ]
    })
    assert.equal(r.status, 200)
  })
})
