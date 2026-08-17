import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AiClient } from '../ai/ai-client.ts'
import { translatePrompt } from '../ai/ai-client.ts'
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
  aiClient: AiClient
  /** 从请求取上下文；由 server.ts 的鉴权钩子填充 */
  ctxOf: (req: FastifyRequest) => {
    tenant: string
    clientUserId?: number
    /** 计费主体：子账号消耗老板的套餐/余额（ownerId ?? 自己） */
    billingUserId?: number
    /** 客户端用户有效权限；静态令牌为 undefined（视为全权限） */
    clientPermissions?: string[]
    principal?: { permissions: string[] }
  }
  requirePerm: (req: FastifyRequest, reply: FastifyReply, perm: string) => boolean
  publicBase: () => string
  /** 订单列表展示用：userId → 邮箱 */
  emailOf?: (userId: number) => string | undefined
  /** 手动调余额时用邮箱定位用户 */
  userIdOf?: (email: string) => number | undefined
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
  const { billing, orders, channels, ai, aiClient, ctxOf, requirePerm, publicBase, emailOf, userIdOf } = deps

  /**
   * 客户端用户守卫：必须是邮箱登录的桌面端用户（静态同步令牌没有身份，不能有钱包）。
   * 返回的是「计费主体」—— 子账号（客服）消耗的是老板的套餐/余额/积分。
   * perm 传入时还要求该客户端用户具备对应权限（子账号 RBAC）。
   */
  const requireClientUser = (
    req: FastifyRequest,
    reply: FastifyReply,
    perm?: string
  ): number | null => {
    const ctx = ctxOf(req)
    if (ctx.clientUserId === undefined) {
      void reply.code(403).send({ error: '需要客户端账号登录（静态令牌无余额体系）' })
      return null
    }
    if (perm && ctx.clientPermissions !== undefined && !ctx.clientPermissions.includes(perm)) {
      void reply.code(403).send({ error: 'forbidden', need: perm })
      return null
    }
    return ctx.billingUserId ?? ctx.clientUserId
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

  /**
   * 管理员手动加/扣余额。走 mutate() 统一入口 —— 必然落一条 adjust 流水，
   * note 里带操作人，事后审计能看到是谁调的。扣成负数会被拒（insufficient）。
   */
  app.post('/api/admin/balance-adjust', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const b = (req.body ?? {}) as {
      userId?: number
      email?: string
      deltaCents?: number
      note?: string
    }
    const tenant = ctxOf(req).tenant
    const userId =
      typeof b.userId === 'number' ? b.userId : b.email ? userIdOf?.(b.email) : undefined
    if (userId === undefined) return reply.code(400).send({ error: '用户不存在（userId 或 email 必填）' })
    const delta = Math.round(Number(b.deltaCents ?? 0))
    if (!Number.isFinite(delta) || delta === 0) {
      return reply.code(400).send({ error: 'deltaCents 必填（正加负扣，美分）' })
    }
    const operator = ctxOf(req).principal ? ` by ${(ctxOf(req).principal as { username?: string }).username ?? 'admin'}` : ''
    const r = billing.mutate(tenant, {
      userId,
      kind: 'adjust',
      amountCents: delta,
      note: `${b.note?.trim() || '管理员手动调整'}${operator}`
    })
    if (!r.ok) return reply.code(400).send({ error: '余额不足，不能扣成负数', reason: r.reason })
    return { ok: true, balance: r.balance }
  })

  // ── 订单（手动补单：测试或线下收款时管理员直接标记已支付）──
  app.get('/api/admin/orders', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const q = req.query as { status?: string }
    return {
      orders: orders.listAll(ctxOf(req).tenant, q.status).map((o) => ({
        ...o,
        email: emailOf?.(o.userId)
      }))
    }
  })

  /**
   * 手动标记已支付。走与支付回调完全相同的结算路径（幂等、套餐单自动开通），
   * 只是跳过金额校验 —— 权限本身就是 billing:manage，责任在管理员。
   */
  app.post('/api/admin/orders/:id/mark-paid', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const tenant = ctxOf(req).tenant
    const orderId = (req.params as { id: string }).id
    const settled = orders.settle(tenant, orderId, { tradeNo: 'manual-admin' })
    if (!settled.ok) {
      const msg =
        settled.reason === 'not_found'
          ? '订单不存在'
          : settled.reason === 'expired'
            ? '订单已过期，请让用户重新下单'
            : `订单状态不允许（${settled.reason}）`
      return reply.code(400).send({ error: msg, reason: settled.reason })
    }
    // 与支付回调同一套后置逻辑：套餐单到账即自动换购
    if (!settled.alreadyPaid && settled.order.kind === 'plan' && settled.order.planId) {
      const change = billing.changePlan(tenant, settled.order.userId, settled.order.planId)
      if (!change.ok) {
        req.log.warn({ orderId, reason: change.reason }, '手动补单后自动换购失败，金额留在余额')
      }
    }
    return { ok: true, alreadyPaid: settled.alreadyPaid ?? false, order: orders.get(tenant, orderId) }
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
    const userId = requireClientUser(req, reply, 'billing:manage')
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
    const userId = requireClientUser(req, reply, 'billing:manage')
    if (userId === null) return
    return { ledger: billing.listLedger(ctxOf(req).tenant, userId) }
  })

  app.get('/api/billing/orders', async (req, reply) => {
    const userId = requireClientUser(req, reply, 'billing:manage')
    if (userId === null) return
    return { orders: orders.listByUser(ctxOf(req).tenant, userId) }
  })

  /**
   * 下单（充值或购买套餐）。
   * 套餐单按整个套餐价建单；支付到账后先充余额、再自动完成换购 ——
   * 折算多出来的部分会留在余额里，用户看流水能看懂每一步。
   */
  app.post('/api/billing/orders', async (req, reply) => {
    const userId = requireClientUser(req, reply, 'billing:manage')
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
    const userId = requireClientUser(req, reply, 'billing:manage')
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
    const userId = requireClientUser(req, reply, 'billing:manage')
    if (userId === null) return
    const on = Boolean((req.body as { on?: boolean } | undefined)?.on)
    const ok = billing.setAutoRenew(ctxOf(req).tenant, userId, on)
    return ok ? { ok: true, on } : reply.code(404).send({ error: '尚无订阅' })
  })

  app.post('/api/billing/exchange-credits', async (req, reply) => {
    const userId = requireClientUser(req, reply, 'billing:manage')
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

  /**
   * AI 翻译（服务端代理调用，密钥不出后台）。
   *
   * 计费顺序：粗预检（防零余额白嫖）→ 调供应商 → 按真实用量扣费。
   * 用量只有调完才知道，所以扣费在后；预检挡掉明显付不起的请求，
   * 把「供应商成本已花但用户没付」的窗口压到单次调用以内。
   * 扣费失败不返回译文 —— 用户没付钱就不能拿到结果。
   */
  app.post('/api/ai/translate', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const b = (req.body ?? {}) as { text?: string; targetLang?: string; modelId?: string }
    if (!b.text?.trim()) return reply.code(400).send({ error: 'text 必填' })
    if (!b.targetLang) return reply.code(400).send({ error: 'targetLang 必填' })
    if (b.text.length > 8000) return reply.code(400).send({ error: '文本过长' })

    const model = b.modelId
      ? ai.getModel(tenant, b.modelId)
      : (ai.listModels(tenant, { purpose: 'translate' }).find((m) => m.enabled) ?? null)
    // 未配置模型回 501：客户端据此回落到免费翻译引擎，而不是当成报错弹给用户
    if (!model || !model.enabled) return reply.code(501).send({ error: '未配置翻译模型' })
    const provider = ai.providerConfig(tenant, model.providerId)
    if (!provider) return reply.code(501).send({ error: '模型所属供应商不可用' })

    // 粗预检：按「字符数≈token 数」高估一次调用的成本，付不起就不去花供应商的钱
    const roughTokens = Math.max(200, b.text.length * 2)
    const estimated = ai.estimate(tenant, model.id, {
      inputTokens: roughTokens,
      outputTokens: roughTokens
    })
    const bal = billing.getBalance(tenant, userId)
    const settings = ai.getSettings(tenant)
    const affordable =
      bal.credits >= estimated ||
      (settings.autoTopUpCredits &&
        bal.balanceCents * (settings.creditsPerUsd / 100) + bal.credits >= estimated)
    if (!affordable) {
      return reply.code(402).send({ error: '积分不足', reason: 'insufficient_credits' })
    }

    const outcome = await aiClient.chat(provider, {
      model: model.modelName,
      system: translatePrompt(b.targetLang),
      messages: [{ role: 'user', content: b.text }],
      temperature: 0
    })
    if (!outcome.ok) return reply.code(502).send({ error: outcome.error ?? '翻译失败' })

    const charge = ai.chargeUsage(tenant, userId, model.id, 'translate', outcome.usage)
    if (!charge.ok) {
      return reply.code(402).send({ error: '扣费失败', reason: charge.reason })
    }
    return { text: outcome.text, credits: charge.credits, usage: outcome.usage, modelId: model.id }
  })

  /**
   * AI 自动回复：带上下文的对话补全，按 autoreply 用途计费。
   * 系统提示由客户端传入（老板配置的业务话术），后台不改写 ——
   * 回复内容的口径应该完全由使用者控制。
   */
  app.post('/api/ai/reply', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const b = (req.body ?? {}) as {
      messages?: Array<{ role?: string; content?: string }>
      system?: string
      modelId?: string
    }
    const messages = (b.messages ?? [])
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0
      )
      .slice(-16)
    if (messages.length === 0) return reply.code(400).send({ error: 'messages 必填' })
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0)
    if (totalChars > 16000) return reply.code(400).send({ error: '上下文过长' })

    const model = b.modelId
      ? ai.getModel(tenant, b.modelId)
      : (ai.listModels(tenant, { purpose: 'autoreply' }).find((m) => m.enabled) ?? null)
    if (!model || !model.enabled) return reply.code(501).send({ error: '未配置自动回复模型' })
    const provider = ai.providerConfig(tenant, model.providerId)
    if (!provider) return reply.code(501).send({ error: '模型所属供应商不可用' })

    const roughTokens = Math.max(500, totalChars * 2)
    const estimated = ai.estimate(tenant, model.id, {
      inputTokens: roughTokens,
      outputTokens: 1000
    })
    const bal = billing.getBalance(tenant, userId)
    const settings = ai.getSettings(tenant)
    const affordable =
      bal.credits >= estimated ||
      (settings.autoTopUpCredits &&
        bal.balanceCents * (settings.creditsPerUsd / 100) + bal.credits >= estimated)
    if (!affordable) {
      return reply.code(402).send({ error: '积分不足', reason: 'insufficient_credits' })
    }

    const outcome = await aiClient.chat(provider, {
      model: model.modelName,
      system: b.system?.slice(0, 4000),
      messages,
      maxTokens: 1024
    })
    if (!outcome.ok) return reply.code(502).send({ error: outcome.error ?? '生成失败' })

    const charge = ai.chargeUsage(tenant, userId, model.id, 'autoreply', outcome.usage)
    if (!charge.ok) return reply.code(402).send({ error: '扣费失败', reason: charge.reason })
    return { text: outcome.text, credits: charge.credits, modelId: model.id }
  })

  /** 语音识别。计费按客户端上报的音频时长（花的是他自己的积分）。 */
  app.post('/api/ai/asr', async (req, reply) => {
    const userId = requireClientUser(req, reply)
    if (userId === null) return
    const tenant = ctxOf(req).tenant
    const b = (req.body ?? {}) as {
      audioBase64?: string
      mimeType?: string
      durationSec?: number
      language?: string
      modelId?: string
    }
    if (!b.audioBase64) return reply.code(400).send({ error: 'audioBase64 必填' })
    const durationSec = Math.max(1, Math.ceil(Number(b.durationSec ?? 0)))
    if (!Number.isFinite(durationSec) || durationSec > 600) {
      return reply.code(400).send({ error: '时长不合法（最长 10 分钟）' })
    }

    const model = b.modelId
      ? ai.getModel(tenant, b.modelId)
      : (ai.listModels(tenant, { purpose: 'asr' }).find((m) => m.enabled) ?? null)
    if (!model || !model.enabled) return reply.code(501).send({ error: '未配置语音识别模型' })
    const provider = ai.providerConfig(tenant, model.providerId)
    if (!provider) return reply.code(501).send({ error: '模型所属供应商不可用' })
    if (provider.type === 'anthropic') {
      return reply.code(400).send({ error: 'Anthropic 协议没有语音识别端点' })
    }

    let audio: Buffer
    try {
      audio = Buffer.from(b.audioBase64, 'base64')
    } catch {
      return reply.code(400).send({ error: '音频编码不合法' })
    }
    if (audio.length === 0 || audio.length > 25 * 1024 * 1024) {
      return reply.code(400).send({ error: '音频大小不合法（最大 25MB）' })
    }

    // 预检：时长已知，成本可以精确预估
    const estimated = ai.estimate(tenant, model.id, { audioSeconds: durationSec })
    const bal = billing.getBalance(tenant, userId)
    const settings = ai.getSettings(tenant)
    const affordable =
      bal.credits >= estimated ||
      (settings.autoTopUpCredits &&
        bal.balanceCents * (settings.creditsPerUsd / 100) + bal.credits >= estimated)
    if (!affordable) {
      return reply.code(402).send({ error: '积分不足', reason: 'insufficient_credits' })
    }

    const outcome = await aiClient.transcribe(provider, {
      modelName: model.modelName,
      audio: new Uint8Array(audio),
      mimeType: b.mimeType || 'audio/ogg',
      language: b.language
    })
    if (!outcome.ok) return reply.code(502).send({ error: outcome.error ?? '识别失败' })

    const charge = ai.chargeUsage(tenant, userId, model.id, 'asr', { audioSeconds: durationSec })
    if (!charge.ok) return reply.code(402).send({ error: '扣费失败', reason: charge.reason })
    return { text: outcome.text, credits: charge.credits, modelId: model.id }
  })

  app.get('/api/billing/usage', async (req, reply) => {
    const userId = requireClientUser(req, reply, 'billing:manage')
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
