import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { IntentAnalyzer } from './analyzer.ts'
import { AiClient } from './ai/ai-client.ts'
import { AiRepo } from './ai/ai-repo.ts'
import { AuthRepo, type Principal } from './auth-repo.ts'
import { BillingRepo } from './billing/billing-repo.ts'
import { startBillingCron } from './billing/billing-cron.ts'
import { registerBillingRoutes } from './billing/billing-routes.ts'
import { ChannelRepo } from './billing/channel-repo.ts'
import { OrderRepo } from './billing/order-repo.ts'
import { CampaignRepo, type CampaignInput } from './campaign-repo.ts'
import { isLibraryChannel, normalizeContactList } from './contact-id.ts'
import { PERMISSIONS, ROLE_PRESETS, ROLES, type Permission } from './auth.ts'
import { ClientAuthRepo } from './client-auth.ts'
import type { ServerConfig } from './config.ts'
import { openDb } from './db.ts'
import { createEmailSender } from './email.ts'
import { LineRelay } from './line-relay.ts'
import { NotifyRepo, type Audience } from './notify/notify-repo.ts'
import { sweepReminders } from './notify/reminder-cron.ts'
import { REMINDER_VARS } from './notify/template.ts'
import { Repo } from './repo.ts'
import { SupportRepo } from './support/support-repo.ts'
import type { SyncPayload } from './types.ts'
import { brand } from './branding.ts'

/** 请求上下文：要么是同步客户端（仅 tenant），要么是登录的管理员（含权限） */
interface ReqCtx {
  tenant: string
  /** 管理员登录用户；同步客户端为空 */
  principal?: Principal
  /** 是否为同步客户端令牌 */
  isSyncClient?: boolean
  /** 客户端用户 id（邮箱登录的桌面端用户才有；静态令牌没有） */
  clientUserId?: number
}

export interface ServerOverrides {
  /** 测试注入：假 AI 客户端，避免真调供应商 */
  aiClient?: AiClient
}

export function buildServer(config: ServerConfig, overrides: ServerOverrides = {}): FastifyInstance {
  const db = openDb(config.dbPath)
  const repo = new Repo(db)
  const auth = new AuthRepo(db)
  const clientAuth = new ClientAuthRepo(db)
  const lineRelay = new LineRelay(db)
  const campaignRepo = new CampaignRepo(db)
  const billingRepo = new BillingRepo(db)
  const orderRepo = new OrderRepo(db, billingRepo)
  const channelRepo = new ChannelRepo(db)
  const aiRepo = new AiRepo(db, billingRepo)
  const notifyRepo = new NotifyRepo(db)
  const supportRepo = new SupportRepo(db)
  const aiClient = overrides.aiClient ?? new AiClient()
  const mailer = createEmailSender(config)
  auth.bootstrap(config.adminTenant, config.adminUser, config.adminPassword)
  mkdirSync(config.mediaDir, { recursive: true })
  const analyzer = config.anthropicApiKey
    ? new IntentAnalyzer(config.anthropicApiKey, config.analysisModel)
    : null

  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 })
  // 前后端分离：管理后台是独立前端（admin/），这里开放跨域即可
  void app.register(cors, { origin: true })

  // 其它 content-type（图片上传等二进制）：不解析，原始流透传给路由
  // —— 否则 Fastify 对未注册类型直接 415，带 image/png 头的上传会被拒
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))

  // 保留 JSON 原始字符串（LINE Webhook 验签需原始字节）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as unknown as { rawBody?: string }).rawBody = body as string
    try {
      done(null, body ? JSON.parse(body as string) : {})
    } catch (err) {
      done(err as Error)
    }
  })

  const publicBase = (): string => config.publicUrl.replace(/\/$/, '')

  /** 分享页 HTML（纯静态文件，首次读取后缓存） */
  let dashboardHtml: string | null = null
  const readDashboardHtml = async (): Promise<string> => {
    if (dashboardHtml === null) {
      const here = dirname(fileURLToPath(import.meta.url))
      const raw = await readFile(join(here, '..', 'public', 'campaign.html'), 'utf8')
      // 白牌：标题占位符在服务端替换，页面本身保持纯静态
      dashboardHtml = raw.replaceAll('__DASHBOARD_TITLE__', brand.dashboardTitle)
    }
    return dashboardHtml
  }

  const bearer = (req: FastifyRequest): string | null => {
    const a = req.headers.authorization
    return a?.startsWith('Bearer ') ? a.slice(7).trim() : null
  }

  // 公开路由前缀（无需鉴权）：管理员登录、客户端注册/登录/发码/配置
  const PUBLIC = ['/api/login', '/api/client/config', '/api/client/register', '/api/client/login', '/api/client/send-code', '/api/client/forgot-password', '/api/client/reset-password']

  // 鉴权：/api 路由（公开的除外）需带有效令牌。
  // 令牌可为「管理员会话」「客户端用户会话」「静态同步令牌」，映射到不同上下文。
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return
    if (PUBLIC.some((p) => req.url.startsWith(p))) return
    const token = bearer(req)
    if (token) {
      const principal = auth.resolve(token)
      if (principal) {
        ;(req as unknown as { ctx?: ReqCtx }).ctx = { tenant: principal.tenant, principal }
        return
      }
      const clientUser = clientAuth.resolve(token)
      if (clientUser) {
        ;(req as unknown as { ctx?: ReqCtx }).ctx = {
          tenant: clientUser.tenant,
          isSyncClient: true,
          clientUserId: clientUser.id
        }
        return
      }
      if (config.tokens.includes(token)) {
        ;(req as unknown as { ctx?: ReqCtx }).ctx = { tenant: token, isSyncClient: true }
        return
      }
    }
    await reply.code(401).send({ error: 'unauthorized' })
  })

  const ctxOf = (req: FastifyRequest): ReqCtx => (req as unknown as { ctx: ReqCtx }).ctx

  /** 权限守卫：要求管理员且具备指定权限 */
  const requirePerm = (req: FastifyRequest, reply: FastifyReply, perm: Permission): boolean => {
    const ctx = ctxOf(req)
    if (!ctx.principal || !ctx.principal.permissions.includes(perm)) {
      void reply.code(403).send({ error: 'forbidden', need: perm })
      return false
    }
    return true
  }

  app.get('/health', async () => ({ ok: true }))

  /**
   * 客户端自动更新分发：/updates/<file>。
   * 只允许安全文件名（防路径穿越），流式返回大安装包。
   * 发布流程：electron-builder 打包后把 latest*.yml 与安装包拷进 updatesDir。
   */
  mkdirSync(config.updatesDir, { recursive: true })
  app.get('/updates/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file
    if (!/^[\w][\w.\- ]*$/.test(file) || file.includes('..')) {
      return reply.code(400).send({ error: 'bad filename' })
    }
    const path = join(config.updatesDir, file)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return reply.code(404).send({ error: 'not found' })
      reply.header('content-length', stat.size)
      // yml 给文本类型，安装包按二进制流
      if (file.endsWith('.yml')) reply.type('text/yaml')
      else reply.type('application/octet-stream')
      return reply.send(createReadStream(path))
    } catch {
      return reply.code(404).send({ error: 'not found' })
    }
  })

  // 到期订阅续费/过期 + 超时订单清理；随服务停止
  const stopBillingCron = startBillingCron({
    billing: billingRepo,
    orders: orderRepo,
    tenants: () => [config.clientTenant],
    logger: app.log
  })
  app.addHook('onClose', async () => stopBillingCron())

  // 到期提醒巡检（每小时；sweep 幂等，重启补跑安全）
  const reminderTimer = setInterval(
    () =>
      void sweepReminders({
        billing: billingRepo,
        notify: notifyRepo,
        emailOf: (_t, userId) => clientAuth.emailOf(userId),
        sendMail: (to, subject, body) => mailer.send(to, subject, body),
        appName: brand.appName,
        tenants: () => [config.clientTenant],
        logger: app.log
      }).then((n) => {
        if (n > 0) app.log.info({ sent: n }, '到期提醒已发送')
      }),
    60 * 60 * 1000
  )
  reminderTimer.unref?.()
  app.addHook('onClose', async () => clearInterval(reminderTimer))

  // LINE 事件队列超龄清理：客户端长期离线时 3 天前的事件已无时效价值
  const linePrune = setInterval(
    () => {
      try {
        const n = lineRelay.pruneStale(config.clientTenant)
        if (n > 0) app.log.info({ pruned: n }, 'LINE 超龄事件已清理')
      } catch (err) {
        app.log.warn({ err: String(err) }, 'LINE 事件清理失败')
      }
    },
    60 * 60 * 1000
  )
  linePrune.unref?.()
  app.addHook('onClose', async () => clearInterval(linePrune))

  registerBillingRoutes(app, {
    billing: billingRepo,
    orders: orderRepo,
    channels: channelRepo,
    ai: aiRepo,
    aiClient,
    ctxOf,
    requirePerm: (req, reply, perm) => requirePerm(req, reply, perm as Permission),
    publicBase
  })

  // ── 客户端用户（桌面端账号）──
  // 客户端启动时拉取：是否需要邮箱验证（决定注册界面是否显示发送验证码）
  app.get('/api/client/config', async () => ({ requireEmailVerify: config.requireEmailVerify }))

  app.post('/api/client/send-code', async (req, reply) => {
    if (!config.requireEmailVerify) return reply.code(400).send({ error: '后台未开启邮箱验证' })
    const { email } = (req.body ?? {}) as { email?: string }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: '邮箱格式不正确' })
    }
    const code = clientAuth.issueCode(email)
    try {
      await mailer.send(email, `${brand.appName} 验证码`, `你的验证码是 ${code}，10 分钟内有效。`)
    } catch (err) {
      req.log.error(err, '验证码邮件发送失败')
      return reply.code(502).send({ error: '验证码发送失败，请稍后重试' })
    }
    return { ok: true }
  })

  /**
   * 找回密码第一步：发验证码。
   * 无论邮箱是否注册都返回 ok —— 否则这个接口就是现成的"撞库探测器"，
   * 攻击者可以批量确认哪些邮箱是你的客户。
   */
  app.post('/api/client/forgot-password', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: '邮箱格式不正确' })
    }
    const normalized = email.trim().toLowerCase()
    if (clientAuth.hasUser(normalized)) {
      const code = clientAuth.issueCode(normalized)
      try {
        await mailer.send(
          normalized,
          `${brand.appName} 重置密码`,
          `你正在重置密码，验证码是 ${code}，10 分钟内有效。若非本人操作请忽略。`
        )
      } catch (err) {
        req.log.error(err, '重置密码邮件发送失败')
        // 发信失败也返回 ok：错误信息同样能被用来探测邮箱是否存在
      }
    }
    return { ok: true }
  })

  /** 找回密码第二步：验码改密。成功后旧会话全部失效，需重新登录。 */
  app.post('/api/client/reset-password', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; code?: string; password?: string }
    if (!b.email || !b.code || !b.password) {
      return reply.code(400).send({ error: '邮箱、验证码、新密码必填' })
    }
    const r = clientAuth.resetPassword(b.email, b.code, b.password)
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { ok: true }
  })

  app.post('/api/client/register', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; password?: string; code?: string }
    if (!b.email || !b.password) return reply.code(400).send({ error: '邮箱和密码必填' })
    const r = clientAuth.register(
      config.clientTenant,
      b.email,
      b.password,
      b.code,
      config.requireEmailVerify
    )
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { token: r.token, user: { email: r.user.email, verified: r.user.verified } }
  })

  app.post('/api/client/login', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; password?: string }
    if (!b.email || !b.password) return reply.code(400).send({ error: '邮箱和密码必填' })
    const r = clientAuth.login(b.email, b.password)
    if (!r) return reply.code(401).send({ error: '邮箱或密码错误' })
    return { token: r.token, user: { email: r.user.email, verified: r.user.verified } }
  })

  app.post('/api/client/logout', async (req) => {
    const token = bearer(req)
    if (token) clientAuth.logout(token)
    return { ok: true }
  })

  // ── 管理员认证 ──
  app.post('/api/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) return reply.code(400).send({ error: 'missing credentials' })
    const r = auth.login(username, password)
    if (!r) return reply.code(401).send({ error: '账号或密码错误' })
    return {
      token: r.token,
      user: {
        username: r.principal.username,
        role: r.principal.role,
        permissions: r.principal.permissions
      }
    }
  })

  app.get('/api/me', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.principal) return reply.code(403).send({ error: 'not an admin session' })
    return {
      username: ctx.principal.username,
      role: ctx.principal.role,
      permissions: ctx.principal.permissions
    }
  })

  app.post('/api/logout', async (req) => {
    const token = bearer(req)
    if (token) auth.logout(token)
    return { ok: true }
  })

  // 权限/角色元数据（前端渲染分配界面用）
  app.get('/api/meta/permissions', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    return { permissions: PERMISSIONS, roles: ROLES, rolePresets: ROLE_PRESETS }
  })

  // ── 用户管理（RBAC：需 users:manage）──
  app.get('/api/users', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    return { users: auth.listUsers(ctxOf(req).tenant) }
  })

  app.post('/api/users', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const b = (req.body ?? {}) as {
      username?: string
      password?: string
      role?: string
      permissions?: string[]
    }
    if (!b.username || !b.password || !b.role) {
      return reply.code(400).send({ error: 'username/password/role required' })
    }
    if (!ROLES.includes(b.role)) return reply.code(400).send({ error: 'invalid role' })
    try {
      const user = auth.createUser(
        ctxOf(req).tenant,
        b.username,
        b.password,
        b.role,
        b.permissions ?? []
      )
      return { user }
    } catch {
      return reply.code(409).send({ error: '用户名已存在' })
    }
  })

  app.patch('/api/users/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const id = Number((req.params as { id: string }).id)
    const b = (req.body ?? {}) as {
      role?: string
      permissions?: string[]
      enabled?: boolean
      password?: string
    }
    if (b.role && !ROLES.includes(b.role)) return reply.code(400).send({ error: 'invalid role' })
    const ok = auth.updateUser(ctxOf(req).tenant, id, b)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/users/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const id = Number((req.params as { id: string }).id)
    // 不允许删除自己
    if (ctxOf(req).principal?.userId === id) {
      return reply.code(400).send({ error: '不能删除当前登录用户' })
    }
    const ok = auth.deleteUser(ctxOf(req).tenant, id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 同步（仅同步客户端令牌）──
  const requireSync = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctxOf(req).isSyncClient) {
      void reply.code(403).send({ error: '需要同步客户端令牌' })
      return false
    }
    return true
  }

  app.post('/api/sync', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const payload = req.body as SyncPayload
    const result = repo.ingest(ctxOf(req).tenant, {
      conversations: payload.conversations ?? [],
      messages: payload.messages ?? []
    })
    return { ok: true, ...result }
  })

  app.post('/api/media/missing', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const { mediaIds } = req.body as { mediaIds: string[] }
    const missing = (mediaIds ?? []).filter((id) => !repo.hasMedia(ctxOf(req).tenant, id))
    return { missing }
  })

  app.put('/api/media/:mediaId', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const tenant = ctxOf(req).tenant
    const mediaId = (req.params as { mediaId: string }).mediaId
    if (!/^[\w.-]+$/.test(mediaId)) return reply.code(400).send({ error: 'invalid mediaId' })
    const dir = join(config.mediaDir, tenant)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, mediaId)
    let size = 0
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        cb(null, chunk)
      }
    })
    await pipeline(req.raw, counter, createWriteStream(path))
    repo.recordMedia(tenant, mediaId, (req.headers['content-type'] as string) || null, path, size)
    return { ok: true, size }
  })

  // ── 查询（需 conversations:read）──
  app.get('/api/conversations', async (req, reply) => {
    if (!requirePerm(req, reply, 'conversations:read')) return
    const q = req.query as { limit?: string; offset?: string }
    return {
      conversations: repo.listConversations(
        ctxOf(req).tenant,
        Number(q.limit) || 100,
        Number(q.offset) || 0
      )
    }
  })

  app.get('/api/conversations/:id/messages', async (req, reply) => {
    if (!requirePerm(req, reply, 'conversations:read')) return
    const id = (req.params as { id: string }).id
    return { messages: repo.listMessages(ctxOf(req).tenant, id, 500) }
  })

  // ── LINE Webhook 中转 ──
  // 客户端注册 LINE 账号（存 channelSecret 用于验签），返回 Webhook 地址
  app.post('/api/line/register', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { accountId?: string; channelSecret?: string }
    if (!b.accountId || !b.channelSecret) {
      return reply.code(400).send({ error: 'accountId/channelSecret required' })
    }
    const tenant = ctxOf(req).tenant
    lineRelay.register(tenant, b.accountId, b.channelSecret)
    return {
      ok: true,
      webhookUrl: `${config.publicUrl.replace(/\/$/, '')}/webhook/line/${encodeURIComponent(tenant)}/${encodeURIComponent(b.accountId)}`
    }
  })

  // LINE 平台回调（公开，靠签名验证）：/webhook/line/:tenant/:accountId
  app.post('/webhook/line/:tenant/:accountId', async (req, reply) => {
    const { tenant, accountId } = req.params as { tenant: string; accountId: string }
    const acct = lineRelay.lookup(tenant, accountId)
    if (!acct) return reply.code(404).send({ error: 'unknown line account' })
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? ''
    const sig = (req.headers['x-line-signature'] as string) || ''
    if (!lineRelay.verifySignature(acct.channelSecret, raw, sig)) {
      return reply.code(401).send({ error: 'bad signature' })
    }
    const events = (req.body as { events?: unknown[] }).events ?? []
    lineRelay.enqueue(tenant, accountId, events)
    return { ok: true }
  })

  // 客户端整机批量拉取（推荐）：一次拿到全部账号的事件
  app.get('/api/line/pull-all', async (req, reply) => {
    if (!requireSync(req, reply)) return
    return { events: lineRelay.pullAll(ctxOf(req).tenant) }
  })

  // 客户端拉取待处理事件（旧接口，保留兼容单账号调试）
  app.get('/api/line/pull', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    return { events: lineRelay.pull(ctxOf(req).tenant, accountId) }
  })

  // ── 引流工单 / 分享链接 / 重粉库 ──
  // 老板在客户端里操作（同步客户端令牌），管理后台也可管（需 campaigns:manage）
  const requireCampaign = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const ctx = ctxOf(req)
    if (ctx.isSyncClient) return true
    return requirePerm(req, reply, 'campaigns:manage')
  }

  app.get('/api/campaigns', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    return { campaigns: campaignRepo.listCampaigns(ctxOf(req).tenant) }
  })

  app.post('/api/campaigns', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const b = (req.body ?? {}) as Partial<CampaignInput>
    if (!b.name?.trim()) return reply.code(400).send({ error: '工单名称必填' })
    if (!Array.isArray(b.accountIds) || b.accountIds.length === 0) {
      return reply.code(400).send({ error: '至少选择一个账号' })
    }
    if (typeof b.startAt !== 'number') return reply.code(400).send({ error: '开始时间必填' })
    if (b.endAt !== undefined && b.endAt !== null && b.endAt <= b.startAt) {
      return reply.code(400).send({ error: '结束时间必须晚于开始时间' })
    }
    const campaign = campaignRepo.createCampaign(
      ctxOf(req).tenant,
      {
        name: b.name.trim(),
        accountIds: b.accountIds,
        accountLabels: b.accountLabels,
        startAt: b.startAt,
        endAt: b.endAt ?? undefined,
        dedupLibraryIds: b.dedupLibraryIds ?? [],
        dedupBeforeAt: b.dedupBeforeAt,
        tzOffsetMinutes: b.tzOffsetMinutes
      },
      ctxOf(req).principal?.username
    )
    return { campaign }
  })

  app.patch('/api/campaigns/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const ok = campaignRepo.updateCampaign(
      ctxOf(req).tenant,
      id,
      (req.body ?? {}) as Partial<CampaignInput>
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/campaigns/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const ok = campaignRepo.deleteCampaign(ctxOf(req).tenant, id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  /** 登录态下的统计预览（与公开看板同一份数据） */
  app.get('/api/campaigns/:id/stats', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const tenant = ctxOf(req).tenant
    const campaign = campaignRepo.getCampaign(tenant, (req.params as { id: string }).id)
    if (!campaign) return reply.code(404).send({ error: 'not found' })
    return { campaign, stats: campaignRepo.statsOf(tenant, campaign) }
  })

  app.get('/api/campaigns/:id/links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    return { links: campaignRepo.listLinks(ctxOf(req).tenant, id), publicBase: publicBase() }
  })

  app.post('/api/campaigns/:id/links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const tenant = ctxOf(req).tenant
    const id = (req.params as { id: string }).id
    if (!campaignRepo.getCampaign(tenant, id)) return reply.code(404).send({ error: 'not found' })
    const b = (req.body ?? {}) as { label?: string; expiresAt?: number | null }
    const link = campaignRepo.createLink(tenant, id, {
      label: b.label,
      // 不传或传 null = 永不过期
      expiresAt: typeof b.expiresAt === 'number' ? b.expiresAt : undefined
    })
    return { link, url: `${publicBase()}/c/${link.token}` }
  })

  app.post('/api/campaigns/links/:token/revoke', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const token = (req.params as { token: string }).token
    const ok = campaignRepo.revokeLink(ctxOf(req).tenant, token)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/campaigns/links/:token', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const token = (req.params as { token: string }).token
    const ok = campaignRepo.deleteLink(ctxOf(req).tenant, token)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 重粉库 ──
  app.get('/api/fan-libraries', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    return { libraries: campaignRepo.listLibraries(ctxOf(req).tenant) }
  })

  /** 导入外部名单：脏格式在这里归一化，问题行原样回报给用户 */
  app.post('/api/fan-libraries/import', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const b = (req.body ?? {}) as {
      name?: string
      channel?: string
      contacts?: string | string[]
      lineProvider?: string
    }
    if (!b.name?.trim()) return reply.code(400).send({ error: '库名称必填' })
    if (!b.channel || !isLibraryChannel(b.channel)) {
      return reply.code(400).send({ error: '平台不支持建库（仅 whatsapp/telegram/line）' })
    }
    if (!b.contacts) return reply.code(400).send({ error: '名单内容必填' })
    const parsed = normalizeContactList(b.channel, b.contacts, { lineProvider: b.lineProvider })
    if (parsed.contactIds.length === 0) {
      return reply.code(400).send({ error: '没有解析出有效标识', detail: parsed })
    }
    const tenant = ctxOf(req).tenant
    const library = campaignRepo.createLibrary(tenant, b.name.trim(), b.channel, 'import')
    const added = campaignRepo.addEntries(tenant, library.id, parsed.contactIds)
    return { library: { ...library, entryCount: added }, added, parsed }
  })

  /** 从系统历史数据导出成库 */
  app.post('/api/fan-libraries/export', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const b = (req.body ?? {}) as {
      name?: string
      channel?: string
      accountIds?: string[]
      from?: number
      to?: number
    }
    if (!b.name?.trim()) return reply.code(400).send({ error: '库名称必填' })
    if (!b.channel || !isLibraryChannel(b.channel)) {
      return reply.code(400).send({ error: '平台不支持建库（仅 whatsapp/telegram/line）' })
    }
    const r = campaignRepo.exportToLibrary(ctxOf(req).tenant, b.name.trim(), b.channel, {
      accountIds: b.accountIds,
      from: b.from,
      to: b.to
    })
    return r
  })

  /** 追加名单到已有库 */
  app.post('/api/fan-libraries/:id/entries', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const tenant = ctxOf(req).tenant
    const id = (req.params as { id: string }).id
    const library = campaignRepo.getLibrary(tenant, id)
    if (!library) return reply.code(404).send({ error: 'not found' })
    if (!isLibraryChannel(library.channel)) {
      return reply.code(400).send({ error: '该库平台不支持导入' })
    }
    const b = (req.body ?? {}) as { contacts?: string | string[]; lineProvider?: string }
    if (!b.contacts) return reply.code(400).send({ error: '名单内容必填' })
    const parsed = normalizeContactList(library.channel, b.contacts, {
      lineProvider: b.lineProvider
    })
    const added = campaignRepo.addEntries(tenant, id, parsed.contactIds)
    return { added, parsed }
  })

  app.delete('/api/fan-libraries/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const ok = campaignRepo.deleteLibrary(ctxOf(req).tenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 公开看板（无需登录，靠不可猜的令牌）──
  // ⚠️ 这里只允许返回聚合数字。任何粉丝身份信息、聊天内容都不得出现。
  app.get('/public/campaign/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ error: r.reason })
    const stats = campaignRepo.statsOf(r.tenant, r.campaign)
    return {
      campaign: {
        name: r.campaign.name,
        startAt: r.campaign.startAt,
        endAt: r.campaign.endAt,
        tzOffsetMinutes: r.campaign.tzOffsetMinutes,
        // 判重口径要让看的人知道，但只给数量不给库内容
        dedup: {
          libraries: r.campaign.dedupLibraryIds.length,
          beforeAt: r.campaign.dedupBeforeAt
        }
      },
      stats
    }
  })

  // 分享页本体：独立静态页，收件人打开一个 URL 就能看
  app.get('/c/:token', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(await readDashboardHtml())
  })

  // ── 运营公告（需 announcements:manage）──
  const AUDIENCES: Audience[] = ['all', 'plan', 'new_users', 'expiring']

  app.get('/api/admin/announcements', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    return { announcements: notifyRepo.listAnnouncements(ctxOf(req).tenant) }
  })

  app.post('/api/admin/announcements', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    const b = (req.body ?? {}) as {
      title?: string
      body?: string
      audience?: string
      audienceParam?: string
    }
    if (!b.title?.trim() || !b.body?.trim()) {
      return reply.code(400).send({ error: '标题与正文必填' })
    }
    const audience = (b.audience ?? 'all') as Audience
    if (!AUDIENCES.includes(audience)) return reply.code(400).send({ error: '受众类型不合法' })
    return {
      announcement: notifyRepo.createAnnouncement(ctxOf(req).tenant, {
        title: b.title.trim(),
        body: b.body,
        audience,
        audienceParam: b.audienceParam ?? ''
      })
    }
  })

  app.patch('/api/admin/announcements/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    const ok = notifyRepo.updateAnnouncement(
      ctxOf(req).tenant,
      (req.params as { id: string }).id,
      (req.body ?? {}) as Record<string, never>
    )
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/admin/announcements/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    const ok = notifyRepo.deleteAnnouncement(ctxOf(req).tenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.get('/api/admin/reminder-settings', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    return { settings: notifyRepo.reminderConfig(ctxOf(req).tenant), vars: REMINDER_VARS }
  })

  app.put('/api/admin/reminder-settings', async (req, reply) => {
    if (!requirePerm(req, reply, 'announcements:manage')) return
    return {
      settings: notifyRepo.updateReminderConfig(
        ctxOf(req).tenant,
        (req.body ?? {}) as Record<string, never>
      )
    }
  })

  // ── 客户端：拉取未读通知（公告 + 个人通知合并） ──
  app.get('/api/notices', async (req, reply) => {
    const ctx = ctxOf(req)
    if (ctx.clientUserId === undefined) {
      return reply.code(403).send({ error: '需要客户端账号登录' })
    }
    const sub = billingRepo.getSubscription(ctx.tenant, ctx.clientUserId)
    const registeredAt = clientAuth.registeredAt(ctx.clientUserId) ?? Date.now()
    const profile = {
      userId: ctx.clientUserId,
      registeredAt,
      planId: sub?.status === 'active' ? sub.planId : undefined,
      expiresAt: sub?.status === 'active' ? sub.expiresAt : undefined
    }
    return {
      announcements: notifyRepo.unreadAnnouncementsFor(ctx.tenant, profile),
      notices: notifyRepo.unreadNotices(ctx.tenant, ctx.clientUserId)
    }
  })

  app.post('/api/notices/read', async (req, reply) => {
    const ctx = ctxOf(req)
    if (ctx.clientUserId === undefined) {
      return reply.code(403).send({ error: '需要客户端账号登录' })
    }
    const b = (req.body ?? {}) as { announcementIds?: string[]; noticeIds?: number[] }
    notifyRepo.markAnnouncementsRead(ctx.tenant, ctx.clientUserId, b.announcementIds ?? [])
    notifyRepo.markNoticesRead(ctx.tenant, ctx.clientUserId, (b.noticeIds ?? []).map(Number))
    return { ok: true }
  })

  // ── 支持工单（软件问题反馈；区别于打粉的引流工单）──

  /** 媒体下载：同租户内已认证即可读（工单贴图、后台看图共用） */
  app.get('/api/media/:mediaId', async (req, reply) => {
    const mediaId = (req.params as { mediaId: string }).mediaId
    if (!/^[\w.\-]+$/.test(mediaId)) return reply.code(400).send({ error: 'bad id' })
    const record = repo.getMedia(ctxOf(req).tenant, mediaId)
    if (!record) return reply.code(404).send({ error: 'not found' })
    reply.type(record.mimeType || 'application/octet-stream')
    return reply.send(createReadStream(record.path))
  })

  // 客户端：我的工单
  app.get('/api/support/tickets', async (req, reply) => {
    const ctx = ctxOf(req)
    if (ctx.clientUserId === undefined) return reply.code(403).send({ error: '需要客户端账号登录' })
    return { tickets: supportRepo.listForUser(ctx.tenant, ctx.clientUserId) }
  })

  app.post('/api/support/tickets', async (req, reply) => {
    const ctx = ctxOf(req)
    if (ctx.clientUserId === undefined) return reply.code(403).send({ error: '需要客户端账号登录' })
    const b = (req.body ?? {}) as { title?: string; body?: string; mediaId?: string }
    if (!b.title?.trim() || !b.body?.trim()) {
      return reply.code(400).send({ error: '标题与描述必填' })
    }
    if (b.title.length > 200 || b.body.length > 8000) {
      return reply.code(400).send({ error: '内容过长' })
    }
    return {
      ticket: supportRepo.create(ctx.tenant, ctx.clientUserId, b.title.trim(), b.body, b.mediaId)
    }
  })

  app.get('/api/support/tickets/:id', async (req, reply) => {
    const ctx = ctxOf(req)
    const id = (req.params as { id: string }).id
    const ticket = supportRepo.get(ctx.tenant, id)
    if (!ticket) return reply.code(404).send({ error: 'not found' })
    // 用户只能看自己的；管理员需 support:manage
    if (ctx.clientUserId !== undefined) {
      if (ticket.userId !== ctx.clientUserId) return reply.code(403).send({ error: 'forbidden' })
    } else if (!ctx.principal?.permissions.includes('support:manage')) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    return { ticket, messages: supportRepo.messages(ctx.tenant, id) }
  })

  app.post('/api/support/tickets/:id/messages', async (req, reply) => {
    const ctx = ctxOf(req)
    const id = (req.params as { id: string }).id
    const ticket = supportRepo.get(ctx.tenant, id)
    if (!ticket) return reply.code(404).send({ error: 'not found' })
    const b = (req.body ?? {}) as { body?: string; mediaId?: string }
    if (!b.body?.trim() && !b.mediaId) return reply.code(400).send({ error: '内容不能为空' })
    if ((b.body ?? '').length > 8000) return reply.code(400).send({ error: '内容过长' })

    if (ctx.clientUserId !== undefined) {
      if (ticket.userId !== ctx.clientUserId) return reply.code(403).send({ error: 'forbidden' })
      supportRepo.addMessage(ctx.tenant, id, 'user', b.body ?? '', { mediaId: b.mediaId })
    } else {
      if (!ctx.principal?.permissions.includes('support:manage')) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      supportRepo.addMessage(ctx.tenant, id, 'admin', b.body ?? '', {
        senderName: ctx.principal.username,
        mediaId: b.mediaId
      })
    }
    return { ticket: supportRepo.get(ctx.tenant, id), messages: supportRepo.messages(ctx.tenant, id) }
  })

  app.post('/api/support/tickets/:id/close', async (req, reply) => {
    const ctx = ctxOf(req)
    const id = (req.params as { id: string }).id
    const ticket = supportRepo.get(ctx.tenant, id)
    if (!ticket) return reply.code(404).send({ error: 'not found' })
    const allowed =
      (ctx.clientUserId !== undefined && ticket.userId === ctx.clientUserId) ||
      ctx.principal?.permissions.includes('support:manage')
    if (!allowed) return reply.code(403).send({ error: 'forbidden' })
    supportRepo.close(ctx.tenant, id)
    return { ok: true }
  })

  // 管理端：全部工单
  app.get('/api/admin/support/tickets', async (req, reply) => {
    if (!requirePerm(req, reply, 'support:manage')) return
    return { tickets: supportRepo.listAll(ctxOf(req).tenant) }
  })

  // ── AI 分析（需 analyze:run）──
  app.post('/api/analyze/conversation/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'analyze:run')) return
    if (!analyzer) return reply.code(501).send({ error: 'AI 分析未配置（缺少 ANTHROPIC_API_KEY）' })
    const id = (req.params as { id: string }).id
    const messages = repo.listMessages(ctxOf(req).tenant, id, 500)
    return { analysis: await analyzer.analyze(messages) }
  })

  app.post('/api/analyze/contact/:contactId', async (req, reply) => {
    if (!requirePerm(req, reply, 'analyze:run')) return
    if (!analyzer) return reply.code(501).send({ error: 'AI 分析未配置（缺少 ANTHROPIC_API_KEY）' })
    const contactId = decodeURIComponent((req.params as { contactId: string }).contactId)
    const messages = repo.messagesByContact(ctxOf(req).tenant, contactId)
    return { analysis: await analyzer.analyze(messages) }
  })

  return app
}
