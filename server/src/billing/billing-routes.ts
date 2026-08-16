import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AiRepo } from '../ai/ai-repo.ts'
import { isModelPurpose } from '../billing/credits.ts'
import type { BillingRepo } from './billing-repo.ts'
import { ChannelRepo, maskChannelConfig, type PaymentChannel } from './channel-repo.ts'
import { MockGateway } from './gateways/mock.ts'
import { PaypalGateway } from './gateways/paypal.ts'
import type { PaymentGateway } from './gateways/types.ts'
import { UsdtGateway } from './gateways/usdt.ts'
import { YipayGateway } from './gateways/yipay.ts'
import type { OrderRepo } from './order-repo.ts'
import type { PeriodUnit } from './plans.ts'

export interface BillingRouteDeps {
  billing: BillingRepo
  orders: OrderRepo
  channels: ChannelRepo
  ai: AiRepo
  /** 从请求取上下文；由 server.ts 的鉴权钩子填充 */
  ctxOf: (req: FastifyRequest) => {
    tenant: string
    clientUserId?: number
    principal?: { permissions: string[] }
  }
  requirePerm: (req: FastifyRequest, reply: FastifyReply, perm: string) => boolean
  publicBase: () => string
}

const GATEWAYS: Record<string, PaymentGateway> = {
  yipay: new YipayGateway(),
  paypal: new PaypalGateway(),
  usdt: new UsdtGateway(),
  mock: new MockGateway()
}

const PERIOD_UNITS: PeriodUnit[] = ['month', 'quarter', 'half_year', 'year', 'day']

/**
 * 计费相关的全部 HTTP 路由。
 *
 * 三类调用方：
 * - 管理后台（billing:manage）：套餐/通道/汇率/AI 供应商配置、用量报表
 * - 客户端用户（邮箱登录）：看套餐、下单、订阅、余额、流水、模型计费
 * - 支付通道（公开回调）：/pay/notify/:tenant/:channelId，靠各通道自己的验签
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  const { billing, orders, channels, ai, ctxOf, requirePerm, publicBase } = deps

  /** 客户端用户守卫：必须是邮箱登录的桌面端用户（静态同步令牌没有身份，不能有钱包） */
  const requireClientUser = (req: FastifyRequest, reply: FastifyReply): number | null => {
    const id = ctxOf(req).clientUserId
    if (id === undefined) {
      void reply.code(403).send({ error: '需要客户端账号登录（静态令牌无余额体系）' })
      return null
    }
    return id
  }

  // ══════════ 管理后台 ══════════

  // ── 套餐 ──
  app.get('/api/admin/plans', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return { plans: billing.listPlans(ctxOf(req).tenant) }
  })

  app.post('/api/admin/plans', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.name || typeof b.name !== 'string') return reply.code(400).send({ error: '名称必填' })
    const unit = String(b.periodUnit ?? 'month') as PeriodUnit
    if (!PERIOD_UNITS.includes(unit)) return reply.code(400).send({ error: '周期不合法' })
    const plan = billing.createPlan(ctxOf(req).tenant, {
      name: b.name,
      priceCents: Number(b.priceCents ?? 0),
      periodUnit: unit,
      periodCount: Number(b.periodCount ?? 1),
      maxAccounts: Number(b.maxAccounts ?? 1),
      enabled: b.enabled !== false,
      sortOrder: Number(b.sortOrder ?? 0)
    })
    return { plan }
  })

  app.patch('/api/admin/plans/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = billing.updatePlan(
      ctxOf(req).tenant,
      (req.params as { id: string }).id,
      (req.body ?? {}) as Parameters<BillingRepo['updatePlan']>[2]
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 支付通道 ──
  app.get('/api/admin/channels', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return {
      channels: channels
        .list(ctxOf(req).tenant)
        .map((c) => ({ ...c, config: maskChannelConfig(c.config) }))
    }
  })

  app.post('/api/admin/channels', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const channel = channels.create(ctxOf(req).tenant, {
      type: String(b.type ?? ''),
      name: String(b.name ?? ''),
      enabled: b.enabled !== false,
      config: (b.config ?? {}) as Record<string, string>,
      feeRate: Number(b.feeRate ?? 0),
      feeFixedCents: Number(b.feeFixedCents ?? 0),
      feePaidBy: b.feePaidBy === 'customer' ? 'customer' : 'merchant',
      currency: String(b.currency ?? 'USD'),
      sortOrder: Number(b.sortOrder ?? 0)
    })
    if (!channel) return reply.code(400).send({ error: '通道类型不支持' })
    return { channel: { ...channel, config: maskChannelConfig(channel.config) } }
  })

  app.patch('/api/admin/channels/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = channels.update(
      ctxOf(req).tenant,
      (req.params as { id: string }).id,
      (req.body ?? {}) as Parameters<ChannelRepo['update']>[2]
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/admin/channels/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = channels.delete(ctxOf(req).tenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 汇率 ──
  app.get('/api/admin/rates', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return { rates: channels.listRates(ctxOf(req).tenant) }
  })

  app.put('/api/admin/rates/:currency', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const currency = (req.params as { currency: string }).currency
    const b = (req.body ?? {}) as { rate?: number; decimals?: number }
    const rate = Number(b.rate)
    if (!Number.isFinite(rate) || rate <= 0) return reply.code(400).send({ error: '汇率必须为正数' })
    channels.setRate(ctxOf(req).tenant, currency, rate, b.decimals ?? 2)
    return { ok: true }
  })

  app.delete('/api/admin/rates/:currency', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = channels.deleteRate(ctxOf(req).tenant, (req.params as { currency: string }).currency)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── AI 供应商与模型 ──
  app.get('/api/admin/ai/providers', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return { providers: ai.listProviders(ctxOf(req).tenant) }
  })

  app.post('/api/admin/ai/providers', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const provider = ai.createProvider(
      ctxOf(req).tenant,
      (req.body ?? {}) as Parameters<AiRepo['createProvider']>[1]
    )
    if (!provider) return reply.code(400).send({ error: '协议类型不支持' })
    return { provider }
  })

  app.patch('/api/admin/ai/providers/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = ai.updateProvider(
      ctxOf(req).tenant,
      (req.params as { id: string }).id,
      (req.body ?? {}) as Parameters<AiRepo['updateProvider']>[2]
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/admin/ai/providers/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = ai.deleteProvider(ctxOf(req).tenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.get('/api/admin/ai/models', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const providerId = (req.query as { providerId?: string }).providerId
    return { models: ai.listModels(ctxOf(req).tenant, { providerId }) }
  })

  app.post('/api/admin/ai/models', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const b = (req.body ?? {}) as Parameters<AiRepo['createModel']>[1]
    if (!b.providerId || !b.modelName) {
      return reply.code(400).send({ error: 'providerId 与 modelName 必填' })
    }
    return { model: ai.createModel(ctxOf(req).tenant, { ...b, purposes: b.purposes ?? [] }) }
  })

  app.patch('/api/admin/ai/models/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = ai.updateModel(
      ctxOf(req).tenant,
      (req.params as { id: string }).id,
      (req.body ?? {}) as Parameters<AiRepo['updateModel']>[2]
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/admin/ai/models/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = ai.deleteModel(ctxOf(req).tenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.get('/api/admin/billing-settings', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return { settings: ai.getSettings(ctxOf(req).tenant) }
  })

  app.put('/api/admin/billing-settings', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return {
      settings: ai.updateSettings(
        ctxOf(req).tenant,
        (req.body ?? {}) as Parameters<AiRepo['updateSettings']>[1]
      )
    }
  })

  app.get('/api/admin/usage-summary', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const q = req.query as { userId?: string; from?: string; to?: string }
    return {
      summary: ai.usageSummary(ctxOf(req).tenant, {
        userId: q.userId ? Number(q.userId) : undefined,
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined
      })
    }
  })

  // ══════════ 客户端 ══════════

  app.get('/api/billing/plans', async (req) => {
    return { plans: billing.listPlans(ctxOf(req).tenant, true) }
  })

  app.get('/api/billing/channels', async (req) => {
    // 客户端只需要知道有哪些通道能付、各自的手续费口径；密钥一律不给
    return {
      channels: channels.list(ctxOf(req).tenant, true).map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        currency: c.currency,
        feeRate: c.feeRate,
        feeFixedCents: c.feeFixedCents,
        feePaidBy: c.feePaidBy
      }))
    }
  })

  app.get('/api/billing/me', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const sub = billing.getSubscription(tenant, userId)
    return {
      balance: billing.getBalance(tenant, userId),
      subscription: sub,
      plan: sub ? billing.getPlan(tenant, sub.planId) : null,
      accountQuota: billing.accountQuota(tenant, userId),
      settings: ai.getSettings(tenant)
    }
  })

  app.get('/api/billing/ledger', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    return { ledger: billing.listLedger(ctxOf(req).tenant, userId) }
  })

  app.get('/api/billing/orders', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    return { orders: orders.listByUser(ctxOf(req).tenant, userId) }
  })

  /**
   * 下单（充值或购买套餐）。
   * 套餐单按整个套餐价建单；支付到账后先充余额、再自动完成换购 ——
   * 折算多出来的部分会留在余额里，用户看流水能看懂每一步。
   */
  app.post('/api/billing/orders', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const b = (req.body ?? {}) as { kind?: string; amountCents?: number; planId?: string; channelId?: string }

    const channel = b.channelId ? channels.get(tenant, b.channelId) : null
    if (!channel || !channel.enabled) return reply.code(400).send({ error: '支付通道不可用' })
    const gateway = GATEWAYS[channel.type]
    if (!gateway) return reply.code(400).send({ error: '通道类型未实现' })

    let kind: 'topup' | 'plan'
    let amountCents: number
    let planId: string | undefined
    if (b.kind === 'plan') {
      const plan = b.planId ? billing.getPlan(tenant, b.planId) : null
      if (!plan || !plan.enabled) return reply.code(400).send({ error: '套餐不可用' })
      kind = 'plan'
      amountCents = plan.priceCents
      planId = plan.id
    } else {
      kind = 'topup'
      amountCents = Math.round(Number(b.amountCents ?? 0))
      if (!(amountCents >= 100)) return reply.code(400).send({ error: '充值金额至少 $1' })
    }

    const rate = channels.getRate(tenant, channel.currency)
    if (!rate) return reply.code(400).send({ error: `未配置 ${channel.currency} 汇率` })

    const order = orders.create(tenant, {
      userId,
      kind,
      amountCents,
      planId,
      channelId: channel.id,
      channelType: channel.type,
      fee: channels.feeOf(channel),
      currency: rate.currency,
      rate: rate.rate,
      decimals: rate.decimals
    })

    const payment = gateway.createPayment(
      {
        orderId: order.id,
        payableCents: order.payableCents,
        currency: order.currency,
        payableLocal: order.payableLocal,
        subject: kind === 'plan' ? '购买套餐' : '余额充值',
        returnUrl: `${publicBase()}/pay/return`,
        notifyUrl: `${publicBase()}/pay/notify/${encodeURIComponent(tenant)}/${encodeURIComponent(channel.id)}`
      },
      channel.config
    )

    return { order, payment }
  })

  /** 用余额订阅/升降级套餐（不经支付通道） */
  app.post('/api/billing/subscribe', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const b = (req.body ?? {}) as { planId?: string }
    if (!b.planId) return reply.code(400).send({ error: 'planId 必填' })
    const r = billing.changePlan(ctxOf(req).tenant, userId, b.planId)
    if (!r.ok) {
      const msg =
        r.reason === 'insufficient_balance'
          ? '余额不足，请先充值'
          : r.reason === 'plan_disabled'
            ? '套餐已停用'
            : '套餐不存在'
      return reply.code(400).send({ error: msg, reason: r.reason })
    }
    return r
  })

  app.post('/api/billing/auto-renew', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const on = Boolean((req.body as { on?: boolean } | undefined)?.on)
    const ok = billing.setAutoRenew(ctxOf(req).tenant, userId, on)
    return ok ? { ok: true, on } : reply.code(404).send({ error: '尚无订阅' })
  })

  app.post('/api/billing/exchange-credits', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const cents = Math.round(Number((req.body as { cents?: number } | undefined)?.cents ?? 0))
    if (!(cents >= 1)) return reply.code(400).send({ error: '金额不合法' })
    const r = billing.exchangeCredits(tenant, userId, cents, {
      creditsPerUsd: ai.getSettings(tenant).creditsPerUsd
    })
    if (!r.ok) return reply.code(400).send({ error: '余额不足', reason: r.reason })
    return r
  })

  // ── 客户端可见的模型与计费 ──
  app.get('/api/billing/models', async (req) => {
    const q = req.query as { purpose?: string }
    const purpose = q.purpose && isModelPurpose(q.purpose) ? q.purpose : undefined
    // 客户端不需要看到单价成本结构以外的东西；供应商密钥更不能给
    return {
      models: ai
        .listModels(ctxOf(req).tenant, { purpose })
        .filter((m) => m.enabled)
        .map((m) => ({ id: m.id, label: m.label || m.modelName, purposes: m.purposes }))
    }
  })

  /** 客户端上报一次模型调用的用量并扣费 */
  app.post('/api/billing/usage/charge', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const b = (req.body ?? {}) as {
      modelId?: string
      purpose?: string
      inputTokens?: number
      outputTokens?: number
      audioSeconds?: number
    }
    if (!b.modelId) return reply.code(400).send({ error: 'modelId 必填' })
    if (!b.purpose || !isModelPurpose(b.purpose)) {
      return reply.code(400).send({ error: 'purpose 不合法' })
    }
    const r = ai.chargeUsage(ctxOf(req).tenant, userId, b.modelId, b.purpose, {
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      audioSeconds: b.audioSeconds
    })
    if (!r.ok) return reply.code(402).send({ error: '扣费失败', reason: r.reason, credits: r.credits })
    return r
  })

  app.get('/api/billing/usage', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    return { usage: ai.listUsage(ctxOf(req).tenant, userId) }
  })

  // ══════════ 支付回调（公开，靠通道验签） ══════════

  app.post('/pay/notify/:tenant/:channelId', async (req, reply) => {
    return handleNotify(req, reply)
  })
  // 易支付等通道用 GET 回调
  app.get('/pay/notify/:tenant/:channelId', async (req, reply) => {
    return handleNotify(req, reply)
  })

  async function handleNotify(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const { tenant, channelId } = req.params as { tenant: string; channelId: string }
    const channel = channels.get(tenant, channelId)
    if (!channel) return reply.code(404).send('unknown channel')
    const gateway = GATEWAYS[channel.type]
    if (!gateway) return reply.code(404).send('unknown gateway')

    // GET 回调参数在 query，POST 在 body（表单或 JSON）
    const params: Record<string, string> = {}
    for (const src of [req.query, req.body]) {
      if (src && typeof src === 'object') {
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number') params[k] = String(v)
        }
      }
    }

    const verified = gateway.verifyCallback(
      {
        params,
        rawBody: (req as unknown as { rawBody?: string }).rawBody,
        headers: req.headers as Record<string, string>
      },
      channel.config
    )
    if (!verified.ok) {
      req.log.warn({ channelId, reason: verified.reason }, '支付回调验签失败')
      return reply.code(400).send('bad callback')
    }
    if (!verified.paid || !verified.orderId) return gateway.callbackAck()

    const settled = orders.settle(tenant, verified.orderId, {
      tradeNo: verified.tradeNo,
      paidAmountLocal: verified.amountLocal
    })
    if (!settled.ok) {
      req.log.warn({ orderId: verified.orderId, reason: settled.reason }, '支付回调结算失败')
      // 金额不符等问题回 400 让通道重试/人工介入；不能回 success 把单吞掉
      return reply.code(400).send('settle failed')
    }

    // 套餐单：到账后自动完成换购。失败也不报错 —— 钱已在余额里，用户可手动再买
    if (!settled.alreadyPaid && settled.order.kind === 'plan' && settled.order.planId) {
      const change = billing.changePlan(tenant, settled.order.userId, settled.order.planId)
      if (!change.ok) {
        req.log.warn(
          { orderId: settled.order.id, reason: change.reason },
          '套餐单到账后自动换购失败，金额已留在余额'
        )
      }
    }

    return gateway.callbackAck()
  }
}
