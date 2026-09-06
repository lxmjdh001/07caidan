import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { IntentAnalyzer, StubAnalyzer } from './analyzer.ts'
import { IntentRepo } from './intent-repo.ts'
import { AutoTagger } from './auto-tagger.ts'
import { AiClient } from './ai/ai-client.ts'
import { AiRepo } from './ai/ai-repo.ts'
import { AuthRepo, type Principal } from './auth-repo.ts'
import { BillingRepo } from './billing/billing-repo.ts'
import { startBillingCron } from './billing/billing-cron.ts'
import { registerBillingRoutes } from './billing/billing-routes.ts'
import { ChannelRepo } from './billing/channel-repo.ts'
import { OrderRepo } from './billing/order-repo.ts'
import { CampaignRepo, type Campaign, type CampaignInput } from './campaign-repo.ts'
import { isLibraryChannel, normalizeContactList } from './contact-id.ts'
import { PERMISSIONS, ROLE_PRESETS, ROLES, type Permission } from './auth.ts'
import { ClientAuthRepo, type ClientUser } from './client-auth.ts'
import { ClientConfigRepo } from './client-config-repo.ts'
import { CLIENT_PERMISSIONS } from './client-rbac.ts'
import type { ServerConfig } from './config.ts'
import { openDb } from './db.ts'
import { createEmailSender } from './email.ts'
import { LineRelay } from './line-relay.ts'
import {
  isMetaChannel,
  MetaService,
  MetaServiceError,
  type MetaOauthResult,
  type MetaOutboundMediaType
} from './meta-service.ts'
import {
  TikTokService,
  TikTokServiceError,
  type TikTokOauthResult
} from './tiktok-service.ts'
import { XService, XServiceError, type XOauthResult } from './x-service.ts'
import {
  SnapchatService,
  SnapchatServiceError,
  type SnapchatOauthResult
} from './snapchat-service.ts'
import { NotifyRepo, type Audience } from './notify/notify-repo.ts'
import { sweepReminders } from './notify/reminder-cron.ts'
import { REMINDER_VARS } from './notify/template.ts'
import { Repo } from './repo.ts'
import { SupportRepo } from './support/support-repo.ts'
import { BATCH_MAX, LogRepo, isLogLevel, type LogEntryInput } from './logs/log-repo.ts'
import type { SyncPayload } from './types.ts'
import { brand } from './branding.ts'
import { regionAllowed } from './geoip/geoip.ts'
import { WorkspaceAccountRepo } from './workspace-account-repo.ts'
import {
  isProxyVendorRegion,
  ProxyVendorRepo,
  type ProxyVendorInput
} from './proxy-vendor-repo.ts'
import { FixedWindowRateLimiter } from './security/rate-limiter.ts'

const DEVELOPMENT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5198',
  'http://127.0.0.1:5198'
]

const PUBLIC_API_PATHS = new Set([
  '/api/logs',
  '/api/login',
  '/api/client/config',
  '/api/client/register',
  '/api/client/login',
  '/api/client/send-code',
  '/api/client/forgot-password',
  '/api/client/reset-password'
])

const PUBLIC_RATE_LIMITS = new Map<string, { limit: number; windowMs: number }>([
  ['POST /api/client/register', { limit: 20, windowMs: 10 * 60_000 }],
  ['POST /api/client/send-code', { limit: 6, windowMs: 10 * 60_000 }],
  ['POST /api/client/forgot-password', { limit: 6, windowMs: 10 * 60_000 }],
  ['POST /api/client/reset-password', { limit: 20, windowMs: 10 * 60_000 }],
  ['POST /api/logs', { limit: 120, windowMs: 60_000 }]
])

function requestPath(url: string): string {
  return url.split('?', 1)[0] || '/'
}

/** 请求上下文：要么是同步客户端（仅 tenant），要么是登录的管理员（含权限） */
interface ReqCtx {
  tenant: string
  /** 管理员登录用户；同步客户端为空 */
  principal?: Principal
  /** 是否为同步客户端令牌 */
  isSyncClient?: boolean
  /** 客户端用户 id（邮箱登录的桌面端用户才有；静态令牌没有） */
  clientUserId?: number
  /** 客户端用户的有效权限（老板全量；子账号 = 角色权限） */
  clientPermissions?: string[]
  /** 计费主体：子账号消耗老板的套餐/余额，所以是 ownerId ?? 自己 */
  billingUserId?: number
  /** 完整客户端用户（团队管理接口需要老板的权限集做委派校验） */
  clientUser?: ClientUser
}

export interface ServerOverrides {
  /** 测试注入：假 AI 客户端，避免真调供应商 */
  aiClient?: AiClient
  /** 测试注入：拦截 Meta OAuth / Graph API 请求，避免真实外网调用。 */
  metaFetch?: typeof fetch
  /** 测试注入：拦截 TikTok OAuth / Business API 请求，避免真实外网调用。 */
  tiktokFetch?: typeof fetch
  /** 测试注入：拦截 X OAuth / Direct Messages API。 */
  xFetch?: typeof fetch
  /** 测试注入：拦截 Snapchat Public Profile API。 */
  snapchatFetch?: typeof fetch
}

export function buildServer(config: ServerConfig, overrides: ServerOverrides = {}): FastifyInstance {
  const db = openDb(config.dbPath)
  const repo = new Repo(db)
  const auth = new AuthRepo(db)
  const clientAuth = new ClientAuthRepo(db)
  const clientConfig = new ClientConfigRepo(db)
  const workspaceAccounts = new WorkspaceAccountRepo(db)
  const proxyVendors = new ProxyVendorRepo(db)
  const lineRelay = new LineRelay(db)
  const metaService = new MetaService(db, config, overrides.metaFetch)
  const tiktokService = new TikTokService(db, config, overrides.tiktokFetch)
  const xService = new XService(db, config, overrides.xFetch)
  const snapchatService = new SnapchatService(db, config, overrides.snapchatFetch)
  const campaignRepo = new CampaignRepo(db)
  const billingRepo = new BillingRepo(db)
  // 设备上限来自计费主体（老板）当前订阅的套餐；注入回调避免 auth 硬依赖 billing
  clientAuth.deviceQuotaResolver = (ownerId) => billingRepo.deviceQuota(config.clientTenant, ownerId)
  const orderRepo = new OrderRepo(db, billingRepo)
  const channelRepo = new ChannelRepo(db)
  const aiRepo = new AiRepo(db, billingRepo)
  const notifyRepo = new NotifyRepo(db)
  const supportRepo = new SupportRepo(db)
  const logRepo = new LogRepo(db)
  const aiClient = overrides.aiClient ?? new AiClient()
  const mailer = createEmailSender(config)
  auth.bootstrap(config.adminTenant, config.adminUser, config.adminPassword)
  if (repo.getTenantSetting(config.clientTenant, 'proxyVendorDefaultsV1') !== '1') {
    proxyVendors.seedDefaults(config.clientTenant)
    repo.setTenantSetting(config.clientTenant, 'proxyVendorDefaultsV1', '1')
  }
  if (repo.getTenantSetting(config.clientTenant, 'proxyVendorDefaultsV2') !== '1') {
    proxyVendors.seedDefaultsV2(config.clientTenant)
    repo.setTenantSetting(config.clientTenant, 'proxyVendorDefaultsV2', '1')
  }
  mkdirSync(config.mediaDir, { recursive: true })
  const analyzer = config.anthropicApiKey
    ? new IntentAnalyzer(config.anthropicApiKey, config.analysisModel)
    : null
  // 实时自动打标签：新入站消息用关键词分析器（零成本）自动打意向标签；
  // Claude 深度分析仍走按需按钮，其结果也落库覆盖关键词标签。
  const intentRepo = new IntentRepo(db)
  const autoTagger = new AutoTagger(repo, intentRepo, {
    analyzer: new StubAnalyzer(),
    enabled: !!config.autoTag
  })

  // trustProxy：前置反代（Caddy/nginx）终止 TLS 时，让 req.ip 取自 X-Forwarded-For，
  // 否则公开看板的地区限制会看到回环地址而全部放行。直连部署保持 false（默认）以防 XFF 伪造。
  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024, trustProxy: config.trustProxy })
  // 生产管理后台与 API 同源，不需要开放全网跨域；本地开发仅允许固定 Vite 地址。
  const allowedCorsOrigins = new Set(
    config.corsOrigins ?? (config.production ? [] : DEVELOPMENT_CORS_ORIGINS)
  )
  void app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || allowedCorsOrigins.has(origin)),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
  })

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

  const publicBase = (tenant?: string): string => {
    const configured = tenant ? repo.getTenantSetting(tenant, 'campaignShareDomain') : undefined
    return (configured || config.campaignShareDomain || config.publicUrl).replace(/\/$/, '')
  }

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

  const publicRateLimiter = new FixedWindowRateLimiter()

  // 鉴权：/api 路由（公开的除外）需带有效令牌。
  // 令牌可为「管理员会话」「客户端用户会话」「静态同步令牌」，映射到不同上下文。
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return
    const path = requestPath(req.url)
    const rateRule = PUBLIC_RATE_LIMITS.get(`${req.method} ${path}`)
    if (config.rateLimitsEnabled !== false && rateRule) {
      const rate = publicRateLimiter.consume(`${req.ip}:${req.method}:${path}`, rateRule.limit, rateRule.windowMs)
      reply.header('X-RateLimit-Remaining', rate.remaining)
      if (!rate.allowed) {
        return reply
          .header('Retry-After', rate.retryAfterSeconds)
          .code(429)
          .send({ error: '请求过于频繁，请稍后再试' })
      }
    }
    if (PUBLIC_API_PATHS.has(path)) return
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
          clientUserId: clientUser.id,
          clientPermissions: clientUser.permissions,
          billingUserId: clientUser.ownerId ?? clientUser.id,
          clientUser
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

  /**
   * 聊天/工单等客户业务数据按“计费主体（老板）”分工作区。
   * 同一老板的 Mac、Windows 和子账号共享；同一 SaaS tenant 下的其他客户绝对不可见。
   * 静态同步令牌与管理后台保持旧 tenant 语义，兼容自托管和既有管理接口。
   */
  const workspaceOf = (req: FastifyRequest): string => {
    const ctx = ctxOf(req)
    return ctx.billingUserId === undefined
      ? ctx.tenant
      : `${ctx.tenant}::workspace:${ctx.billingUserId}`
  }

  /** 只允许管理员在自己租户的基础空间和数字客户工作区之间定位数据。 */
  const requestedAdminWorkspace = (
    req: FastifyRequest,
    reply: FastifyReply
  ): string | null | undefined => {
    const ctx = ctxOf(req)
    if (!ctx.principal) return undefined
    const raw = (req.query as { workspace?: unknown }).workspace
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || raw.length > 256) {
      void reply.code(400).send({ error: '工作区标识无效' })
      return null
    }
    const prefix = `${ctx.tenant}::workspace:`
    if (raw !== ctx.tenant && (!raw.startsWith(prefix) || !/^\d+$/.test(raw.slice(prefix.length)))) {
      void reply.code(403).send({ error: 'forbidden' })
      return null
    }
    return raw
  }

  /**
   * 客户端永远锁定自己工作区；管理端优先用前端回传的 workspace。
   * 兼容旧管理端：未传时按实体 id 解析，如果同 id 出现在多个客户下则拒绝猜测。
   */
  const resolvedWorkspace = (
    req: FastifyRequest,
    reply: FastifyReply,
    candidates: () => string[]
  ): string | null => {
    const ctx = ctxOf(req)
    if (!ctx.principal) return workspaceOf(req)
    const requested = requestedAdminWorkspace(req, reply)
    if (requested === null) return null
    if (requested !== undefined) return requested
    const matches = [...new Set(candidates())]
    if (matches.length > 1) {
      void reply.code(409).send({ error: '同名数据属于多个客户，请指定工作区' })
      return null
    }
    return matches[0] ?? ctx.tenant
  }

  const syncUserOf = (req: FastifyRequest): number => ctxOf(req).clientUserId ?? 0

  /** 权限守卫：要求管理员且具备指定权限 */
  const requirePerm = (req: FastifyRequest, reply: FastifyReply, perm: Permission): boolean => {
    const ctx = ctxOf(req)
    if (!ctx.principal || !ctx.principal.permissions.includes(perm)) {
      void reply.code(403).send({ error: 'forbidden', need: perm })
      return false
    }
    return true
  }

  /**
   * 客户端权限守卫（子账号 RBAC）。
   * 静态同步令牌视为全权限（开发/自托管场景）；
   * 邮箱登录的客户端用户按其有效权限判定 —— 界面隐藏只是体验，这里才是安全。
   */
  const requireClientPerm = (req: FastifyRequest, reply: FastifyReply, perm: string): boolean => {
    const ctx = ctxOf(req)
    if (ctx.clientPermissions !== undefined && !ctx.clientPermissions.includes(perm)) {
      void reply.code(403).send({ error: 'forbidden', need: perm })
      return false
    }
    return true
  }

  /**
   * 会话历史既可由管理后台读取，也可由已登录桌面端恢复本租户自己的本地缓存。
   * 客户端权限表只控制管理功能；聊天是老板和客服的基础能力，不另设权限点。
   */
  const requireConversationRead = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const ctx = ctxOf(req)
    if (ctx.isSyncClient) return true
    return requirePerm(req, reply, 'conversations:read')
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
      try {
        const n = logRepo.prune()
        if (n > 0) app.log.info({ pruned: n }, '过期客户端日志已清理')
      } catch (err) {
        app.log.warn({ err: String(err) }, '客户端日志清理失败')
      }
      try {
        const pruned = metaService.prune()
        if (pruned.oauth || pruned.events) app.log.info({ pruned }, 'Meta 超龄状态已清理')
      } catch (err) {
        app.log.warn({ err: String(err) }, 'Meta 状态清理失败')
      }
      try {
        const pruned = tiktokService.prune()
        if (pruned.oauth || pruned.events) app.log.info({ pruned }, 'TikTok 超龄状态已清理')
      } catch (err) {
        app.log.warn({ err: String(err) }, 'TikTok 状态清理失败')
      }
      try {
        const xPruned = xService.prune()
        const snapPruned = snapchatService.prune()
        if (xPruned.oauth || snapPruned.oauth || snapPruned.sent) {
          app.log.info({ x: xPruned, snapchat: snapPruned }, 'X / Snapchat 超龄状态已清理')
        }
      } catch (err) {
        app.log.warn({ err: String(err) }, 'X / Snapchat 状态清理失败')
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
    emailOf: (userId) => clientAuth.emailOf(userId),
    userIdOf: (email) => clientAuth.userIdOf(email),
    publicBase
  })

  // ── 客户端用户（桌面端账号）──
  // 客户端启动时拉取：是否需要邮箱验证（决定注册界面是否显示发送验证码）
  app.get('/api/client/config', async () => ({
    requireEmailVerify: config.requireEmailVerify,
    // Crisp Website ID 本身即公开信息（网页上人人可见），下发给客户端无风险
    crispWebsiteId: config.crispWebsiteId,
    meta: {
      facebook: metaService.available('facebook'),
      instagram: metaService.available('instagram')
    },
    tiktok: tiktokService.available(),
    x: xService.available(),
    snapchat: snapchatService.available()
  }))

  /** 客户端代理采购目录：只下发已上架项目，不包含任何代理账号或密钥。 */
  app.get('/api/proxy-vendors', async (req, reply) => {
    const { region } = (req.query ?? {}) as { region?: string }
    if (region !== undefined && !isProxyVendorRegion(region)) {
      return reply.code(400).send({ error: 'region 必须是 global 或 china' })
    }
    return {
      vendors: proxyVendors.list(config.clientTenant, {
        enabledOnly: true,
        ...(region ? { region } : {})
      })
    }
  })

  app.post('/api/client/send-code', async (req, reply) => {
    if (!config.requireEmailVerify) return reply.code(400).send({ error: '后台未开启邮箱验证' })
    if (config.production && !config.smtp) {
      return reply.code(503).send({ error: '邮件服务暂不可用' })
    }
    const { email } = (req.body ?? {}) as { email?: string }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: '邮箱格式不正确' })
    }
    // 开发模式（未配 SMTP）验证码固定 12345；配置 SMTP 后走真实邮件
    const code = clientAuth.issueCode(email, config.smtp ? undefined : '12345')
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
    // 生产环境未配置 SMTP 时绝不签发固定开发验证码，否则已知邮箱可被直接重置密码。
    if (clientAuth.hasUser(normalized) && (config.smtp || !config.production)) {
      const code = clientAuth.issueCode(normalized, config.smtp ? undefined : '12345')
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
    const b = (req.body ?? {}) as {
      email?: string
      password?: string
      code?: string
      deviceId?: string
      deviceName?: string
    }
    if (!b.email || !b.password) return reply.code(400).send({ error: '邮箱和密码必填' })
    const r = clientAuth.register(
      config.clientTenant,
      b.email,
      b.password,
      b.code,
      config.requireEmailVerify,
      { deviceId: b.deviceId, deviceName: b.deviceName }
    )
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return {
      token: r.token,
      user: {
        email: r.user.email,
        verified: r.user.verified,
        role: r.user.role,
        permissions: r.user.permissions
      }
    }
  })

  app.post('/api/client/login', async (req, reply) => {
    const b = (req.body ?? {}) as {
      email?: string
      password?: string
      deviceId?: string
      deviceName?: string
    }
    if (!b.email || !b.password) return reply.code(400).send({ error: '邮箱和密码必填' })
    const loginIdentity = b.email.trim().toLowerCase()
    const clientIpKey = `client-login:ip:${req.ip}`
    const clientAccountKey = `client-login:account:${loginIdentity}`
    const clientIpRate = config.rateLimitsEnabled === false
      ? { allowed: true, remaining: 30, retryAfterSeconds: 0 }
      : publicRateLimiter.check(clientIpKey, 30, 5 * 60_000)
    const clientAccountRate = config.rateLimitsEnabled === false
      ? { allowed: true, remaining: 10, retryAfterSeconds: 0 }
      : publicRateLimiter.check(clientAccountKey, 10, 5 * 60_000)
    if (!clientIpRate.allowed || !clientAccountRate.allowed) {
      return reply
        .header('Retry-After', Math.max(clientIpRate.retryAfterSeconds, clientAccountRate.retryAfterSeconds))
        .code(429)
        .send({ error: '请求过于频繁，请稍后再试' })
    }
    const r = clientAuth.login(b.email, b.password, { deviceId: b.deviceId, deviceName: b.deviceName })
    if (!r) {
      if (config.rateLimitsEnabled !== false) {
        publicRateLimiter.consume(clientIpKey, 30, 5 * 60_000)
        publicRateLimiter.consume(clientAccountKey, 10, 5 * 60_000)
      }
      return reply.code(401).send({ error: '邮箱或密码错误' })
    }
    if (config.rateLimitsEnabled !== false) {
      publicRateLimiter.reset(clientIpKey)
      publicRateLimiter.reset(clientAccountKey)
    }
    // 设备数超限：给出当前设备列表，让用户远程下线其一后再登录
    if ('deviceLimit' in r) {
      return reply.code(403).send({
        error: '登录设备数已达套餐上限，请先在其它设备退出或远程下线',
        code: 'device_limit',
        maxDevices: r.maxDevices,
        devices: r.devices
      })
    }
    return {
      token: r.token,
      user: {
        email: r.user.email,
        verified: r.user.verified,
        role: r.user.role,
        permissions: r.user.permissions
      }
    }
  })

  // ── 设备管理（远程下线）：任何已登录客户端用户可管理自己计费主体的设备 ──
  app.get('/api/client/devices', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) return reply.code(403).send({ error: '需要客户端账号登录' })
    return { devices: clientAuth.listDevices(ctx.clientUser, bearer(req) ?? undefined) }
  })

  app.post('/api/client/devices/revoke', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) return reply.code(403).send({ error: '需要客户端账号登录' })
    const b = (req.body ?? {}) as { deviceId?: string }
    if (!b.deviceId) return reply.code(400).send({ error: 'deviceId 必填' })
    const revoked = clientAuth.revokeDevice(ctx.clientUser, b.deviceId)
    return { ok: true, revoked }
  })

  // ── 配置云同步（跨设备漫游非敏感偏好；凭证/会话绝不入云）──
  app.get('/api/client/settings', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) return reply.code(403).send({ error: '需要客户端账号登录' })
    return clientConfig.get(ctx.clientUser.tenant, ctx.clientUser.id) ?? { blob: {}, updatedAt: 0 }
  })

  app.put('/api/client/settings', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) return reply.code(403).send({ error: '需要客户端账号登录' })
    const b = (req.body ?? {}) as { blob?: unknown; updatedAt?: number }
    if (!b.blob || typeof b.blob !== 'object' || Array.isArray(b.blob)) {
      return reply.code(400).send({ error: 'blob 必须是对象' })
    }
    const updatedAt = typeof b.updatedAt === 'number' && b.updatedAt > 0 ? b.updatedAt : Date.now()
    return clientConfig.put(
      ctx.clientUser.tenant,
      ctx.clientUser.id,
      b.blob as Record<string, unknown>,
      updatedAt
    )
  })

  // ── 客户工作区账号目录（跨设备，仅非敏感摘要）──
  app.get('/api/client/accounts', async (req, reply) => {
    if (!ctxOf(req).isSyncClient) return reply.code(403).send({ error: '需要同步客户端令牌' })
    return { accounts: workspaceAccounts.list(workspaceOf(req)) }
  })

  app.put('/api/client/accounts/:accountKey', async (req, reply) => {
    if (!ctxOf(req).isSyncClient) return reply.code(403).send({ error: '需要同步客户端令牌' })
    const accountKey = (req.params as { accountKey: string }).accountKey
    const b = (req.body ?? {}) as { channel?: string; accountId?: string; label?: unknown; defaultLang?: unknown }
    if (!validAccountIdentity(accountKey, b.channel, b.accountId)) {
      return reply.code(400).send({ error: '账号标识无效' })
    }
    return {
      account: workspaceAccounts.upsert(workspaceOf(req), {
        accountKey,
        channel: b.channel!,
        accountId: b.accountId!,
        label: cleanOptionalText(b.label, 200),
        defaultLang: cleanOptionalText(b.defaultLang, 32)
      })
    }
  })

  app.delete('/api/client/accounts/:accountKey', async (req, reply) => {
    if (!ctxOf(req).isSyncClient) return reply.code(403).send({ error: '需要同步客户端令牌' })
    const accountKey = (req.params as { accountKey: string }).accountKey
    const parsed = parseAccountIdentity(accountKey)
    if (!parsed) return reply.code(400).send({ error: '账号标识无效' })
    return { account: workspaceAccounts.remove(workspaceOf(req), accountKey, parsed.channel, parsed.accountId) }
  })

  app.post('/api/client/logout', async (req) => {
    const token = bearer(req)
    if (token) clientAuth.logout(token)
    return { ok: true }
  })

  // ══════════ 团队管理（老板 → 客服子账号；M21 客户端 RBAC）══════════

  /** 团队接口守卫：必须是邮箱登录的客户端用户且具备 team:manage */
  const requireTeamOwner = (req: FastifyRequest, reply: FastifyReply): ClientUser | null => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) {
      void reply.code(403).send({ error: '需要客户端账号登录' })
      return null
    }
    if (!ctx.clientUser.permissions.includes('team:manage')) {
      void reply.code(403).send({ error: 'forbidden', need: 'team:manage' })
      return null
    }
    return ctx.clientUser
  }

  app.get('/api/team/members', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    return { members: clientAuth.listMembers(owner) }
  })

  app.post('/api/team/members', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    const b = (req.body ?? {}) as { username?: string; password?: string; role?: string }
    if (!b.username || !b.password) return reply.code(400).send({ error: '用户名和密码必填' })
    const r = clientAuth.createMember(owner, b.username, b.password, b.role ?? 'agent')
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { member: r.member }
  })

  app.patch('/api/team/members/:id', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    const id = Number((req.params as { id: string }).id)
    const b = (req.body ?? {}) as { role?: string; enabled?: boolean; password?: string }
    const r = clientAuth.updateMember(owner, id, b)
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { ok: true }
  })

  app.delete('/api/team/members/:id', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    const r = clientAuth.deleteMember(owner, Number((req.params as { id: string }).id))
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { ok: true }
  })

  app.get('/api/team/roles', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    return { roles: clientAuth.listRoles(owner), permissions: CLIENT_PERMISSIONS }
  })

  app.post('/api/team/roles', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    const b = (req.body ?? {}) as { name?: string; permissions?: string[] }
    if (!b.name?.trim()) return reply.code(400).send({ error: '角色名称必填' })
    const r = clientAuth.createRole(owner, b.name.trim(), b.permissions ?? [])
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { role: r.role }
  })

  app.delete('/api/team/roles/:id', async (req, reply) => {
    const owner = requireTeamOwner(req, reply)
    if (!owner) return
    const r = clientAuth.deleteRole(owner, (req.params as { id: string }).id)
    if (!r.ok) return reply.code(400).send({ error: r.error ?? 'not_found' })
    return { ok: true }
  })

  // ══════════ 客户端日志上报（M19）══════════

  /**
   * 批量上报。登录用户带令牌（关联 userId）；未登录也能报（游客日志，
   * 靠设备指纹归拢）—— 登录前崩溃恰恰是最需要日志的场景。
   * 响应带回该用户的目标日志级别，客户端据此调整过滤门槛。
   */
  app.post('/api/logs', async (req, reply) => {
    const b = (req.body ?? {}) as {
      deviceId?: string
      appVersion?: string
      osType?: string
      osVersion?: string
      entries?: LogEntryInput[]
    }
    if (!b.deviceId || !/^[a-f0-9]{8,64}$/i.test(b.deviceId)) {
      return reply.code(400).send({ error: 'deviceId 必填（硬件指纹哈希）' })
    }
    if (!Array.isArray(b.entries)) return reply.code(400).send({ error: 'entries 必填' })
    if (b.entries.length > BATCH_MAX) {
      return reply.code(400).send({ error: `单批最多 ${BATCH_MAX} 条` })
    }
    // 游客与登录用户共用此路由：令牌有效则关联用户，无令牌落游客日志
    const token = bearer(req)
    const user = token ? clientAuth.resolve(token) : null
    const tenant = user?.tenant ?? config.clientTenant
    const added = logRepo.ingest(tenant, user?.id, {
      deviceId: b.deviceId.toLowerCase(),
      appVersion: b.appVersion,
      osType: b.osType,
      osVersion: b.osVersion
    }, b.entries)
    return { ok: true, added, level: logRepo.levelFor(tenant, user?.id) }
  })

  // ── 管理后台：日志查看与级别控制 ──

  app.get('/api/admin/logs', async (req, reply) => {
    if (!requirePerm(req, reply, 'support:manage')) return
    const q = req.query as Record<string, string | undefined>
    const { logs, total } = logRepo.list(ctxOf(req).tenant, {
      level: q.level,
      userId: q.userId ? Number(q.userId) : undefined,
      deviceId: q.deviceId,
      q: q.q,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined
    })
    return {
      total,
      logs: logs.map((r) => ({
        ...r,
        email: r.userId === null ? undefined : clientAuth.emailOf(r.userId)
      }))
    }
  })

  app.get('/api/admin/logs/devices', async (req, reply) => {
    if (!requirePerm(req, reply, 'support:manage')) return
    const tenant = ctxOf(req).tenant
    return {
      devices: logRepo.devices(tenant).map((d) => ({
        ...d,
        email: d.userId === null ? undefined : clientAuth.emailOf(d.userId)
      })),
      levels: logRepo.listLevels(tenant)
    }
  })

  app.post('/api/admin/logs/level', async (req, reply) => {
    if (!requirePerm(req, reply, 'support:manage')) return
    const b = (req.body ?? {}) as { userId?: number; level?: string }
    if (typeof b.userId !== 'number' || !b.level || !isLogLevel(b.level)) {
      return reply.code(400).send({ error: 'userId 与合法 level 必填（debug/info/warn/error）' })
    }
    logRepo.setLevel(ctxOf(req).tenant, b.userId, b.level)
    return { ok: true }
  })

  /** 客户端启动时拉自己的身份与权限（会话仍有效时刷新权限用） */
  app.get('/api/me/permissions', async (req, reply) => {
    const ctx = ctxOf(req)
    if (!ctx.clientUser) return reply.code(403).send({ error: '需要客户端账号登录' })
    return {
      userId: ctx.clientUser.id,
      email: ctx.clientUser.email,
      role: ctx.clientUser.role,
      permissions: ctx.clientUser.permissions
    }
  })

  // ── 管理员认证 ──
  app.post('/api/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) return reply.code(400).send({ error: 'missing credentials' })
    const loginIdentity = username.trim().toLowerCase()
    const adminIpKey = `admin-login:ip:${req.ip}`
    const adminAccountKey = `admin-login:account:${loginIdentity}`
    const adminIpRate = config.rateLimitsEnabled === false
      ? { allowed: true, remaining: 20, retryAfterSeconds: 0 }
      : publicRateLimiter.check(adminIpKey, 20, 5 * 60_000)
    const adminAccountRate = config.rateLimitsEnabled === false
      ? { allowed: true, remaining: 10, retryAfterSeconds: 0 }
      : publicRateLimiter.check(adminAccountKey, 10, 5 * 60_000)
    if (!adminIpRate.allowed || !adminAccountRate.allowed) {
      return reply
        .header('Retry-After', Math.max(adminIpRate.retryAfterSeconds, adminAccountRate.retryAfterSeconds))
        .code(429)
        .send({ error: '请求过于频繁，请稍后再试' })
    }
    const r = auth.login(username, password)
    if (!r) {
      if (config.rateLimitsEnabled !== false) {
        publicRateLimiter.consume(adminIpKey, 20, 5 * 60_000)
        publicRateLimiter.consume(adminAccountKey, 10, 5 * 60_000)
      }
      return reply.code(401).send({ error: '账号或密码错误' })
    }
    if (config.rateLimitsEnabled !== false) {
      publicRateLimiter.reset(adminIpKey)
      publicRateLimiter.reset(adminAccountKey)
    }
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

  // ── 注册用户管理（桌面端账号，需 users:manage）──
  app.get('/api/admin/client-users', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const tenant = ctxOf(req).tenant
    const users = clientAuth.listAdminUsers(tenant)
    const byId = new Map(users.map((u) => [u.id, u.email]))
    return {
      users: users.map((u) => {
        const billingUserId = u.ownerId ?? u.id
        const subscription = billingRepo.getSubscription(tenant, billingUserId)
        const plan = subscription ? billingRepo.getPlan(tenant, subscription.planId) : null
        const balance = billingRepo.getBalance(tenant, billingUserId)
        return {
          ...u,
          ownerEmail: u.ownerId ? byId.get(u.ownerId) : undefined,
          balanceCents: balance.balanceCents,
          credits: balance.credits,
          subscription: subscription
            ? { ...subscription, planName: plan?.name ?? subscription.planId }
            : null
        }
      })
    }
  })

  app.post('/api/admin/client-users', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const b = (req.body ?? {}) as { email?: string; password?: string; verified?: boolean }
    if (!b.email || !b.password) return reply.code(400).send({ error: '邮箱和密码必填' })
    const result = clientAuth.createAdminUser(ctxOf(req).tenant, b.email, b.password, b.verified !== false)
    return result.ok ? { user: result.user } : reply.code(400).send({ error: result.error })
  })

  app.patch('/api/admin/client-users/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const id = Number((req.params as { id: string }).id)
    const b = (req.body ?? {}) as { email?: string; password?: string; enabled?: boolean; verified?: boolean }
    const result = clientAuth.updateAdminUser(ctxOf(req).tenant, id, b)
    return result.ok ? { ok: true } : reply.code(400).send({ error: result.error })
  })

  app.delete('/api/admin/client-users/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    const id = Number((req.params as { id: string }).id)
    const result = clientAuth.deleteAdminUser(ctxOf(req).tenant, id)
    return result.ok ? { ok: true } : reply.code(result.error === '用户不存在' ? 404 : 409).send({ error: result.error })
  })

  app.patch('/api/admin/client-users/:id/subscription', async (req, reply) => {
    if (!requirePerm(req, reply, 'users:manage')) return
    if (!requirePerm(req, reply, 'billing:manage')) return
    const id = Number((req.params as { id: string }).id)
    const user = clientAuth.listAdminUsers(ctxOf(req).tenant).find((u) => u.id === id)
    if (!user) return reply.code(404).send({ error: '用户不存在' })
    const b = (req.body ?? {}) as { planId?: string; expiresAt?: number; autoRenew?: boolean; status?: string }
    if (!b.planId) return reply.code(400).send({ error: '请选择套餐' })
    const subscription = billingRepo.setSubscriptionByAdmin(ctxOf(req).tenant, user.ownerId ?? user.id, {
      planId: b.planId,
      expiresAt: b.expiresAt,
      autoRenew: b.autoRenew,
      status: b.status
    })
    return subscription ? { subscription } : reply.code(404).send({ error: '套餐不存在' })
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

  /**
   * 客户端代理出口检测：必须带同步客户端令牌，响应只返回本次 TCP 请求的来源 IP。
   * 客户端以账号 dispatcher 调用它，因此成功即证明该账号代理链路可达；没有任何
   * “代理失败后直连”的备用请求。
   */
  app.get('/api/network/diagnostic', async (req, reply) => {
    if (!requireSync(req, reply)) return
    reply.header('cache-control', 'no-store')
    return { ip: req.ip, at: Date.now() }
  })

  app.post('/api/sync', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const payload = req.body as SyncPayload
    const tenant = workspaceOf(req)
    const result = repo.ingest(tenant, {
      conversations: payload.conversations ?? [],
      messages: payload.messages ?? [],
      accountProfiles: payload.accountProfiles ?? []
    })
    // 实时自动打标签：对本批有入站消息的会话按需重算意向（非阻塞，不拖慢同步）
    if (autoTagger.active) {
      const inboundConvs = [
        ...new Set((payload.messages ?? []).filter((m) => m.direction === 'in').map((m) => m.conversationId))
      ]
      if (inboundConvs.length > 0) void autoTagger.tag(tenant, inboundConvs)
    }
    return { ok: true, ...result }
  })

  /**
   * 桌面端从服务器主库增量回填。只接受客户端同步令牌；聊天是所有客户端角色的基础能力。
   * 由 (updatedAt, externalId) 组成游标，任何设备切换后都能继续从上次位置恢复。
   */
  app.get('/api/sync/pull', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { after?: string; afterId?: string; limit?: string }
    const after = Math.max(0, Number(q.after) || 0)
    const afterId = typeof q.afterId === 'string' ? q.afterId.slice(0, 256) : ''
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 500))
    const tenant = workspaceOf(req)
    const pulled = repo.pullMessages(tenant, after, afterId, limit)
    const cursor = pulled.length > 0
      ? { updatedAt: pulled[pulled.length - 1]!.syncUpdatedAt, externalId: pulled[pulled.length - 1]!.externalId }
      : null
    return { messages: pulled, conversations: repo.conversationsForMessages(tenant, pulled), cursor }
  })

  app.get('/api/sync/conversations', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { after?: string; afterId?: string; limit?: string }
    const after = Math.max(0, Number(q.after) || 0)
    const afterId = typeof q.afterId === 'string' ? q.afterId.slice(0, 1024) : ''
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 500))
    const conversations = repo.pullConversations(workspaceOf(req), after, afterId, limit)
    const last = conversations.at(-1)
    return {
      conversations,
      cursor: last ? { updatedAt: last.syncUpdatedAt, id: last.id } : null
    }
  })

  /** 独立的已读游标流：同一登录账号的多台电脑共享，团队内不同坐席互不干扰。 */
  app.get('/api/sync/reads', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { after?: string; afterId?: string; limit?: string }
    const after = Math.max(0, Number(q.after) || 0)
    const afterId = typeof q.afterId === 'string' ? q.afterId.slice(0, 512) : ''
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 500))
    const reads = repo.pullReads(workspaceOf(req), syncUserOf(req), after, afterId, limit)
    const last = reads.at(-1)
    return {
      reads,
      cursor: last ? { updatedAt: last.updatedAt, conversationId: last.conversationId } : null
    }
  })

  app.put('/api/conversations/:id/read', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const id = (req.params as { id: string }).id
    if (!id || id.length > 1024) return reply.code(400).send({ error: '会话标识无效' })
    return { ok: true, ...repo.markRead(workspaceOf(req), syncUserOf(req), id) }
  })

  /** 多设备并发副作用抢占；同一来信只有一台电脑拿到 claimed=true。 */
  app.post('/api/sync/claim', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { purpose?: string; key?: string }
    if (!b.purpose || !/^[a-z0-9_-]{1,64}$/i.test(b.purpose) || !b.key || b.key.length > 2048) {
      return reply.code(400).send({ error: 'claim 参数无效' })
    }
    return { claimed: repo.claim(workspaceOf(req), b.purpose, b.key) }
  })

  app.post('/api/media/missing', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const { mediaIds } = req.body as { mediaIds: string[] }
    const tenant = workspaceOf(req)
    const missing = (mediaIds ?? []).filter((id) => !repo.hasMedia(tenant, id))
    return { missing }
  })

  app.put('/api/media/:mediaId', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const tenant = workspaceOf(req)
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
    if (!requireConversationRead(req, reply)) return
    const q = req.query as { limit?: string; offset?: string }
    const ctx = ctxOf(req)
    const convs = ctx.principal
      ? repo.listConversationsForAdmin(ctx.tenant, Number(q.limit) || 100, Number(q.offset) || 0)
      : repo.listConversations(workspaceOf(req), Number(q.limit) || 100, Number(q.offset) || 0)
    // 附加已落库的意向标签（实时自动打标签结果），无则不带
    return {
      conversations: convs.map((c) => {
        const tenant = (c as { workspace?: string }).workspace ?? workspaceOf(req)
        const level = intentRepo.get(tenant, c.id)?.level
        return level ? { ...c, intentLevel: level } : c
      })
    }
  })

  app.get('/api/conversations/:id/messages', async (req, reply) => {
    if (!requireConversationRead(req, reply)) return
    const id = (req.params as { id: string }).id
    const q = req.query as { limit?: string; offset?: string }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 500))
    const offset = Math.max(0, Number(q.offset) || 0)
    const tenant = resolvedWorkspace(req, reply, () => repo.conversationWorkspacesForAdmin(ctxOf(req).tenant, id))
    if (tenant === null) return
    return { messages: repo.listMessages(tenant, id, limit, offset) }
  })

  // 已落库的意向分析（实时自动打标签或按需深度分析的结果），供打开会话即展示
  app.get('/api/conversations/:id/intent', async (req, reply) => {
    if (!requirePerm(req, reply, 'conversations:read')) return
    const id = (req.params as { id: string }).id
    const tenant = resolvedWorkspace(req, reply, () => repo.conversationWorkspacesForAdmin(ctxOf(req).tenant, id))
    if (tenant === null) return
    const s = intentRepo.get(tenant, id)
    return {
      intent: s
        ? {
            intentLevel: s.level,
            summary: s.summary,
            signals: s.signals,
            suggestedAction: s.suggestedAction,
            analyzedAt: s.analyzedAt
          }
        : null
    }
  })

  // ── LINE Webhook 中转 ──
  // 客户端注册 LINE 账号（存 channelSecret 用于验签），返回 Webhook 地址
  app.post('/api/line/register', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { accountId?: string; channelSecret?: string }
    if (!b.accountId || !b.channelSecret) {
      return reply.code(400).send({ error: 'accountId/channelSecret required' })
    }
    const tenant = workspaceOf(req)
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
    return { events: lineRelay.pullAll(workspaceOf(req)) }
  })

  // 客户端拉取待处理事件（旧接口，保留兼容单账号调试）
  app.get('/api/line/pull', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    return { events: lineRelay.pull(workspaceOf(req), accountId) }
  })

  // ── Facebook Messenger / Instagram 官方接入 ──
  // Meta 应用凭证只配置在服务器。桌面端发起授权后打开系统浏览器，回调令牌在这里
  // 换取并加密保存；客户和桌面渲染进程都不会接触 App Secret / Page Token。
  const metaOwnerId = (req: FastifyRequest): number => {
    const ctx = ctxOf(req)
    return ctx.billingUserId ?? ctx.clientUserId ?? 0
  }
  const metaFailure = (reply: FastifyReply, error: unknown) => {
    const status = error instanceof MetaServiceError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(status).send({ error: message })
  }

  app.post('/api/meta/oauth/start', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const b = (req.body ?? {}) as { channel?: string; accountId?: string }
    if (!isMetaChannel(b.channel) || !b.accountId) {
      return reply.code(400).send({ error: 'channel/accountId required' })
    }
    try {
      return metaService.beginOauth(ctxOf(req).tenant, metaOwnerId(req), b.channel, b.accountId)
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.get('/api/meta/account', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { channel?: string; accountId?: string }
    if (!isMetaChannel(q.channel) || !q.accountId) {
      return reply.code(400).send({ error: 'channel/accountId required' })
    }
    try {
      return await metaService.oauthStatus(ctxOf(req).tenant, metaOwnerId(req), q.channel, q.accountId)
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  // 新电脑登录同一团队后，可据此恢复已授权的 Meta 账号注册表；响应只有公开摘要。
  app.get('/api/meta/accounts', async (req, reply) => {
    if (!requireSync(req, reply)) return
    try {
      return { accounts: metaService.listAccounts(ctxOf(req).tenant, metaOwnerId(req)) }
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.delete('/api/meta/account', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const q = req.query as { channel?: string; accountId?: string }
    if (!isMetaChannel(q.channel) || !q.accountId) {
      return reply.code(400).send({ error: 'channel/accountId required' })
    }
    try {
      metaService.disconnect(ctxOf(req).tenant, metaOwnerId(req), q.channel, q.accountId)
      return { ok: true }
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.get('/api/meta/events', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { channel?: string; accountId?: string }
    if (!isMetaChannel(q.channel) || !q.accountId) {
      return reply.code(400).send({ error: 'channel/accountId required' })
    }
    try {
      return {
        events: metaService.pullEvents(ctxOf(req).tenant, metaOwnerId(req), q.channel, q.accountId)
      }
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.get('/api/meta/history', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { channel?: string; accountId?: string }
    if (!isMetaChannel(q.channel) || !q.accountId) {
      return reply.code(400).send({ error: 'channel/accountId required' })
    }
    try {
      return {
        conversations: await metaService.history(
          ctxOf(req).tenant,
          metaOwnerId(req),
          q.channel,
          q.accountId
        )
      }
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.get('/api/meta/profile', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { channel?: string; accountId?: string; userId?: string }
    if (!isMetaChannel(q.channel) || !q.accountId || !q.userId) {
      return reply.code(400).send({ error: 'channel/accountId/userId required' })
    }
    try {
      return {
        profile: await metaService.profile(
          ctxOf(req).tenant,
          metaOwnerId(req),
          q.channel,
          q.accountId,
          q.userId
        )
      }
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.post('/api/meta/send', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as {
      channel?: string
      accountId?: string
      recipientId?: string
      text?: string
    }
    if (!isMetaChannel(b.channel) || !b.accountId || !b.recipientId || !b.text?.trim()) {
      return reply.code(400).send({ error: 'channel/accountId/recipientId/text required' })
    }
    if (b.text.length > 2000) return reply.code(400).send({ error: '消息不能超过 2000 字符' })
    try {
      return await metaService.sendText(
        ctxOf(req).tenant,
        metaOwnerId(req),
        b.channel,
        b.accountId,
        b.recipientId,
        b.text
      )
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  app.post('/api/meta/send-media', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as {
      channel?: string
      accountId?: string
      recipientId?: string
      mediaType?: string
      mimeType?: string
      dataBase64?: string
    }
    const mediaTypes: MetaOutboundMediaType[] = ['image', 'video', 'audio', 'document', 'sticker']
    if (
      !isMetaChannel(b.channel) || !b.accountId || !b.recipientId ||
      !b.mediaType || !mediaTypes.includes(b.mediaType as MetaOutboundMediaType) ||
      !b.mimeType || !b.dataBase64
    ) {
      return reply.code(400).send({ error: 'channel/accountId/recipientId/mediaType/mimeType/dataBase64 required' })
    }
    try {
      return await metaService.sendMedia(
        ctxOf(req).tenant,
        metaOwnerId(req),
        b.channel,
        b.accountId,
        b.recipientId,
        b.mediaType as MetaOutboundMediaType,
        b.mimeType,
        b.dataBase64
      )
    } catch (error) {
      return metaFailure(reply, error)
    }
  })

  // Meta 会通过该短期签名 URL 拉取待发送媒体。无签名、过期或不存在均统一 404。
  app.get('/meta-media/:file', async (req, reply) => {
    const file = (req.params as { file?: string }).file || ''
    const q = req.query as { expires?: string; signature?: string }
    const media = metaService.resolveStagedMedia(file, q.expires, q.signature)
    if (!media) return reply.code(404).send({ error: 'not found' })
    reply.header('cache-control', 'private, max-age=300')
    reply.header('x-content-type-options', 'nosniff')
    reply.type(media.mimeType)
    return reply.send(createReadStream(media.path))
  })

  // Meta 后台验证 Webhook 时是 GET；Facebook 与 Instagram 共用一个 HTTPS 入口。
  app.get('/webhook/meta', async (req, reply) => {
    const q = req.query as {
      'hub.mode'?: string
      'hub.verify_token'?: string
      'hub.challenge'?: string
    }
    if (!metaService.verifyWebhookChallenge(q['hub.mode'], q['hub.verify_token'])) {
      return reply.code(403).type('text/plain').send('verification failed')
    }
    return reply.type('text/plain').send(q['hub.challenge'] ?? '')
  })

  app.post('/webhook/meta', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? ''
    const signature = req.headers['x-hub-signature-256'] as string | undefined
    if (!metaService.verifyWebhookSignature(raw, signature)) {
      return reply.code(401).send({ error: 'bad signature' })
    }
    const queued = metaService.enqueueWebhook(req.body)
    return { ok: true, queued }
  })

  // OAuth 浏览器回调不依赖桌面登录 Cookie；高熵 state 把回调精确绑定到发起授权的团队账号。
  app.get('/oauth/meta/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string }
    if (!q.state) return reply.code(400).type('text/html').send(metaOauthHtml({
      status: 'error', message: '授权回调缺少 state，请回到客户端重试。'
    }))
    let result: MetaOauthResult
    try {
      result = await metaService.completeOauth(
        q.state,
        q.code,
        q.error_description || q.error
      )
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'")
    return reply.type('text/html').send(metaOauthHtml(result, q.state))
  })

  app.get('/oauth/meta/select', async (req, reply) => {
    const q = req.query as { state?: string; resource?: string }
    let result: MetaOauthResult
    try {
      if (!q.state || !q.resource) throw new MetaServiceError('缺少主页选择参数。')
      result = await metaService.selectOauthResource(q.state, q.resource)
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
    return reply.type('text/html').send(metaOauthHtml(result))
  })

  // ── TikTok Business Messaging 官方接入 ──
  // 每个客户在 TikTok 网页完成自己的企业号授权；短期 access token 与一年期 refresh token
  // 均加密留在服务器，桌面端只拿账号摘要、会话和事件。
  const tiktokFailure = (reply: FastifyReply, error: unknown) => {
    const status = error instanceof TikTokServiceError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(status).send({ error: message })
  }

  app.post('/api/tiktok/oauth/start', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.body as { accountId?: string } | undefined)?.accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return tiktokService.beginOauth(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.get('/api/tiktok/account', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return await tiktokService.oauthStatus(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.get('/api/tiktok/accounts', async (req, reply) => {
    if (!requireSync(req, reply)) return
    try {
      return { accounts: tiktokService.listAccounts(ctxOf(req).tenant, metaOwnerId(req)) }
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.delete('/api/tiktok/account', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      tiktokService.disconnect(ctxOf(req).tenant, metaOwnerId(req), accountId)
      return { ok: true }
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.get('/api/tiktok/events', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return { events: tiktokService.pullEvents(ctxOf(req).tenant, metaOwnerId(req), accountId) }
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.get('/api/tiktok/history', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return { conversations: await tiktokService.history(ctxOf(req).tenant, metaOwnerId(req), accountId) }
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.get('/api/tiktok/profile', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { accountId?: string; conversationId?: string }
    if (!q.accountId || !q.conversationId) {
      return reply.code(400).send({ error: 'accountId/conversationId required' })
    }
    try {
      return {
        profile: await tiktokService.profile(
          ctxOf(req).tenant,
          metaOwnerId(req),
          q.accountId,
          q.conversationId
        )
      }
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.post('/api/tiktok/send', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { accountId?: string; conversationId?: string; text?: string }
    if (!b.accountId || !b.conversationId || !b.text?.trim()) {
      return reply.code(400).send({ error: 'accountId/conversationId/text required' })
    }
    try {
      return await tiktokService.sendText(
        ctxOf(req).tenant,
        metaOwnerId(req),
        b.accountId,
        b.conversationId,
        b.text
      )
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.post('/api/tiktok/send-media', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as {
      accountId?: string
      conversationId?: string
      mediaType?: string
      mimeType?: string
      dataBase64?: string
    }
    if (
      !b.accountId || !b.conversationId || b.mediaType !== 'image' ||
      !b.mimeType || !b.dataBase64
    ) {
      return reply.code(400).send({
        error: 'accountId/conversationId/mediaType=image/mimeType/dataBase64 required'
      })
    }
    try {
      return await tiktokService.sendImage(
        ctxOf(req).tenant,
        metaOwnerId(req),
        b.accountId,
        b.conversationId,
        b.mimeType,
        b.dataBase64
      )
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  // 入站图片/视频必须由服务器携账号 token 向 TikTok 换临时 URL，再携 x-user 下载。
  // 此接口只返回媒体字节，永不把 token 或临时下载地址交给桌面端。
  app.get('/api/tiktok/media', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as {
      accountId?: string
      conversationId?: string
      messageId?: string
      mediaId?: string
      mediaType?: string
    }
    if (
      !q.accountId || !q.conversationId || !q.messageId || !q.mediaId ||
      (q.mediaType !== 'IMAGE' && q.mediaType !== 'VIDEO')
    ) {
      return reply.code(400).send({
        error: 'accountId/conversationId/messageId/mediaId/mediaType required'
      })
    }
    try {
      const media = await tiktokService.downloadMedia(
        ctxOf(req).tenant,
        metaOwnerId(req),
        q.accountId,
        q.conversationId,
        q.messageId,
        q.mediaId,
        q.mediaType
      )
      reply.header('cache-control', 'private, max-age=300')
      reply.header('x-content-type-options', 'nosniff')
      reply.type(media.mimeType)
      return reply.send(media.bytes)
    } catch (error) {
      return tiktokFailure(reply, error)
    }
  })

  app.post('/webhook/tiktok', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? ''
    const header = req.headers['tiktok-signature']
    const signature = Array.isArray(header) ? header[0] : header
    if (!tiktokService.verifyWebhookSignature(raw, signature)) {
      return reply.code(401).send({ error: 'bad signature' })
    }
    return { ok: true, queued: tiktokService.enqueueWebhook(req.body) }
  })

  app.get('/oauth/tiktok/callback', async (req, reply) => {
    const q = req.query as {
      state?: string
      auth_code?: string
      code?: string
      error?: string
      error_description?: string
    }
    if (!q.state) {
      return reply.code(400).type('text/html').send(tiktokOauthHtml({
        status: 'error', message: '授权回调缺少 state，请回到客户端重试。'
      }))
    }
    let result: TikTokOauthResult
    try {
      result = await tiktokService.completeOauth(
        q.state,
        q.auth_code || q.code,
        q.error_description || q.error
      )
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
    return reply.type('text/html').send(tiktokOauthHtml(result))
  })

  // ── X Direct Messages 官方接入 ──
  const xFailure = (reply: FastifyReply, error: unknown) => {
    const status = error instanceof XServiceError ? error.status : 500
    return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) })
  }

  app.post('/api/x/oauth/start', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.body as { accountId?: string } | undefined)?.accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return xService.beginOauth(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.get('/api/x/account', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return await xService.oauthStatus(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.get('/api/x/accounts', async (req, reply) => {
    if (!requireSync(req, reply)) return
    return { accounts: xService.listAccounts(ctxOf(req).tenant, metaOwnerId(req)) }
  })

  app.delete('/api/x/account', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      xService.disconnect(ctxOf(req).tenant, metaOwnerId(req), accountId)
      return { ok: true }
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.get('/api/x/history', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return { conversations: await xService.history(ctxOf(req).tenant, metaOwnerId(req), accountId) }
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.get('/api/x/profile', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const q = req.query as { accountId?: string; userId?: string }
    if (!q.accountId || !q.userId) return reply.code(400).send({ error: 'accountId/userId required' })
    try {
      return { profile: await xService.profile(ctxOf(req).tenant, metaOwnerId(req), q.accountId, q.userId) }
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.post('/api/x/send', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { accountId?: string; conversationId?: string; text?: string }
    if (!b.accountId || !b.conversationId || !b.text?.trim()) {
      return reply.code(400).send({ error: 'accountId/conversationId/text required' })
    }
    try {
      return await xService.sendText(ctxOf(req).tenant, metaOwnerId(req), b.accountId, b.conversationId, b.text)
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.post('/api/x/send-media', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as {
      accountId?: string
      conversationId?: string
      mimeType?: string
      dataBase64?: string
      text?: string
    }
    if (!b.accountId || !b.conversationId || !b.mimeType || !b.dataBase64) {
      return reply.code(400).send({ error: 'accountId/conversationId/mimeType/dataBase64 required' })
    }
    try {
      return await xService.sendImage(
        ctxOf(req).tenant, metaOwnerId(req), b.accountId, b.conversationId, b.mimeType, b.dataBase64, b.text
      )
    } catch (error) {
      return xFailure(reply, error)
    }
  })

  app.get('/oauth/x/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string }
    if (!q.state) {
      return reply.code(400).type('text/html').send(oauthResultHtml('X', {
        status: 'error', message: '授权回调缺少 state，请回到客户端重试。'
      }))
    }
    let result: XOauthResult
    try {
      result = await xService.completeOauth(q.state, q.code, q.error_description || q.error)
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
    return reply.type('text/html').send(oauthResultHtml('X', result))
  })

  // ── Snapchat Public Profile Messaging 官方接入 ──
  const snapchatFailure = (reply: FastifyReply, error: unknown) => {
    const status = error instanceof SnapchatServiceError ? error.status : 500
    return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) })
  }

  app.post('/api/snapchat/oauth/start', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.body as { accountId?: string } | undefined)?.accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return snapchatService.beginOauth(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.get('/api/snapchat/account', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return await snapchatService.oauthStatus(ctxOf(req).tenant, metaOwnerId(req), accountId)
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.get('/api/snapchat/accounts', async (req, reply) => {
    if (!requireSync(req, reply)) return
    return { accounts: snapchatService.listAccounts(ctxOf(req).tenant, metaOwnerId(req)) }
  })

  app.delete('/api/snapchat/account', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      snapchatService.disconnect(ctxOf(req).tenant, metaOwnerId(req), accountId)
      return { ok: true }
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.post('/api/snapchat/creators/connect', async (req, reply) => {
    if (!requireSync(req, reply) || !requireClientPerm(req, reply, 'accounts:manage')) return
    const b = (req.body ?? {}) as { accountId?: string; creatorProfileIds?: string[] }
    if (!b.accountId || !Array.isArray(b.creatorProfileIds)) {
      return reply.code(400).send({ error: 'accountId/creatorProfileIds required' })
    }
    try {
      return await snapchatService.connectCreators(
        ctxOf(req).tenant, metaOwnerId(req), b.accountId, b.creatorProfileIds
      )
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.get('/api/snapchat/history', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const accountId = (req.query as { accountId?: string }).accountId
    if (!accountId) return reply.code(400).send({ error: 'accountId required' })
    try {
      return { conversations: await snapchatService.history(ctxOf(req).tenant, metaOwnerId(req), accountId) }
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.post('/api/snapchat/send', async (req, reply) => {
    if (!requireSync(req, reply)) return
    const b = (req.body ?? {}) as { accountId?: string; conversationId?: string; text?: string }
    if (!b.accountId || !b.conversationId || !b.text?.trim()) {
      return reply.code(400).send({ error: 'accountId/conversationId/text required' })
    }
    try {
      return await snapchatService.sendText(
        ctxOf(req).tenant, metaOwnerId(req), b.accountId, b.conversationId, b.text
      )
    } catch (error) {
      return snapchatFailure(reply, error)
    }
  })

  app.get('/oauth/snapchat/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string }
    if (!q.state) {
      return reply.code(400).type('text/html').send(oauthResultHtml('Snapchat', {
        status: 'error', message: '授权回调缺少 state，请回到客户端重试。'
      }))
    }
    let result: SnapchatOauthResult
    try {
      result = await snapchatService.completeOauth(q.state, q.code, q.error_description || q.error)
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
    return reply.type('text/html').send(oauthResultHtml('Snapchat', result))
  })

  // ── 引流工单 / 分享链接 / 重粉库 ──
  // 老板在客户端里操作（同步客户端令牌），管理后台也可管（需 campaigns:manage）
  const requireCampaign = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const ctx = ctxOf(req)
    if (ctx.isSyncClient) return requireClientPerm(req, reply, 'campaigns:manage')
    return requirePerm(req, reply, 'campaigns:manage')
  }

  const campaignWorkspace = (req: FastifyRequest, reply: FastifyReply, id: string): string | null =>
    resolvedWorkspace(req, reply, () => campaignRepo.campaignWorkspacesForAdmin(ctxOf(req).tenant, id))
  const campaignLinkWorkspace = (req: FastifyRequest, reply: FastifyReply, token: string): string | null =>
    resolvedWorkspace(req, reply, () => campaignRepo.linkWorkspacesForAdmin(ctxOf(req).tenant, token))
  const libraryWorkspace = (req: FastifyRequest, reply: FastifyReply, id: string): string | null =>
    resolvedWorkspace(req, reply, () => campaignRepo.libraryWorkspacesForAdmin(ctxOf(req).tenant, id))

  app.get('/api/campaigns', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const ctx = ctxOf(req)
    return {
      campaigns: ctx.principal
        ? campaignRepo.listCampaignsForAdmin(ctx.tenant)
        : campaignRepo.listCampaigns(workspaceOf(req))
    }
  })

  app.post('/api/campaigns', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const b = (req.body ?? {}) as Partial<CampaignInput>
    if (!b.name?.trim()) return reply.code(400).send({ error: '工单名称必填' })
    if (!Array.isArray(b.accountIds) || b.accountIds.length === 0) {
      return reply.code(400).send({ error: '至少选择一个账号' })
    }
    if (typeof b.startAt !== 'number') return reply.code(400).send({ error: '开始时间必填' })
    if (b.accessPasswordEnabled === true && (!b.accessPassword || b.accessPassword.length < 6 || b.accessPassword.length > 12)) {
      return reply.code(400).send({ error: '访问密码必须为 6-12 位' })
    }
    if (b.endAt !== undefined && b.endAt !== null && b.endAt <= b.startAt) {
      return reply.code(400).send({ error: '结束时间必须晚于开始时间' })
    }
    const campaign = campaignRepo.createCampaign(
      workspaceOf(req),
      {
        name: b.name.trim(),
        accountIds: b.accountIds,
        accountLabels: b.accountLabels,
        accountProfiles: b.accountProfiles,
        totalTarget: b.totalTarget,
        accessPasswordEnabled: b.accessPasswordEnabled === true,
        accessPassword: b.accessPassword,
        // 旧客户端未传时维持历史行为；新版客户端会明确提交开关值。
        allowFanData: b.allowFanData !== false,
        accountTargets: b.accountTargets,
        accountTargetsManual: b.accountTargetsManual === true,
        resetTime: b.resetTime,
        startAt: b.startAt,
        endAt: b.endAt ?? undefined,
        dedupLibraryIds: b.dedupLibraryIds ?? [],
        dedupBeforeAt: b.dedupBeforeAt,
        dedupAccountIds: b.dedupAccountIds ?? [],
        sourceCodes: b.sourceCodes ?? [],
        allowCnIp: b.allowCnIp === true,
        allowHkIp: b.allowHkIp === true,
        tzOffsetMinutes: b.tzOffsetMinutes
      },
      ctxOf(req).principal?.username
    )
    return { campaign }
  })

  app.patch('/api/campaigns/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const patch = (req.body ?? {}) as Partial<CampaignInput> & { endAt?: number | null }
    const tenant = campaignWorkspace(req, reply, id)
    if (tenant === null) return
    const existing = campaignRepo.getCampaign(tenant, id)
    if (!existing) return reply.code(404).send({ error: 'not found' })
    if (patch.name !== undefined && !patch.name.trim()) {
      return reply.code(400).send({ error: '工单名称不能为空' })
    }
    if (patch.accessPassword !== undefined && (patch.accessPassword.length < 6 || patch.accessPassword.length > 12)) {
      return reply.code(400).send({ error: '访问密码必须为 6-12 位' })
    }
    if (patch.accessPasswordEnabled === true && !existing.accessPasswordEnabled && !patch.accessPassword) {
      return reply.code(400).send({ error: '开启访问密码时请输入 6-12 位密码' })
    }
    if (patch.accountIds !== undefined && patch.accountIds.length === 0) {
      return reply.code(400).send({ error: '至少保留一个参与账号' })
    }
    // 时间要按补丁后的最终值联合校验，只看单个字段会放过「把开始改到结束之后」
    const start = patch.startAt ?? existing.startAt
    const end = 'endAt' in patch ? (patch.endAt ?? undefined) : existing.endAt
    if (end !== undefined && end <= start) {
      return reply.code(400).send({ error: '结束时间必须晚于开始时间' })
    }
    campaignRepo.updateCampaign(tenant, id, patch)
    return { ok: true, campaign: campaignRepo.getCampaign(tenant, id) }
  })

  app.delete('/api/campaigns/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const tenant = campaignWorkspace(req, reply, id)
    if (tenant === null) return
    const ok = campaignRepo.deleteCampaign(tenant, id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  /** 登录态下的统计预览（与公开看板同一份数据） */
  app.get('/api/campaigns/:id/stats', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const tenant = campaignWorkspace(req, reply, id)
    if (tenant === null) return
    const campaign = campaignRepo.getCampaign(tenant, id)
    if (!campaign) return reply.code(404).send({ error: 'not found' })
    return { campaign, stats: campaignRepo.statsOf(tenant, campaign) }
  })


  app.get('/api/campaigns/:id/links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const tenant = campaignWorkspace(req, reply, id)
    if (tenant === null) return
    return { links: campaignRepo.listLinks(tenant, id), publicBase: publicBase(tenant) }
  })

  app.post('/api/campaigns/:id/links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const tenant = campaignWorkspace(req, reply, id)
    if (tenant === null) return
    if (!campaignRepo.getCampaign(tenant, id)) return reply.code(404).send({ error: 'not found' })
    const b = (req.body ?? {}) as { label?: string; expiresAt?: number | null }
    const link = campaignRepo.createLink(tenant, id, {
      label: b.label,
      // 不传或传 null = 永不过期
      expiresAt: typeof b.expiresAt === 'number' ? b.expiresAt : undefined
    })
    return { link, url: `${publicBase(tenant)}/c/${link.token}` }
  })

  app.post('/api/campaigns/links/:token/revoke', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const token = (req.params as { token: string }).token
    const tenant = campaignLinkWorkspace(req, reply, token)
    if (tenant === null) return
    const ok = campaignRepo.revokeLink(tenant, token)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.post('/api/campaigns/links/:token/restore', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const token = (req.params as { token: string }).token
    const tenant = campaignLinkWorkspace(req, reply, token)
    if (tenant === null) return
    const ok = campaignRepo.restoreLink(tenant, token)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  app.delete('/api/campaigns/links/:token', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const token = (req.params as { token: string }).token
    const tenant = campaignLinkWorkspace(req, reply, token)
    if (tenant === null) return
    const ok = campaignRepo.deleteLink(tenant, token)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 推广入口链接（保存多条区分来源；campaigns:manage）──
  app.get('/api/entry-links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    return { links: campaignRepo.listEntryLinks(workspaceOf(req)) }
  })

  app.post('/api/entry-links', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const b = (req.body ?? {}) as {
      name?: string
      channel?: string
      accountId?: string
      handle?: string
      code?: string
      greeting?: string
    }
    if (!b.name?.trim()) return reply.code(400).send({ error: '备注名必填' })
    if (!b.channel || !b.accountId || !b.handle?.trim() || !b.code?.trim()) {
      return reply.code(400).send({ error: '渠道、账号、句柄与追踪码必填' })
    }
    return {
      link: campaignRepo.createEntryLink(workspaceOf(req), {
        name: b.name.trim(),
        channel: b.channel,
        accountId: b.accountId,
        handle: b.handle.trim(),
        code: b.code.trim(),
        greeting: b.greeting
      })
    }
  })

  app.delete('/api/entry-links/:id', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const ok = campaignRepo.deleteEntryLink(workspaceOf(req), (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 重粉库 ──
  app.get('/api/fan-libraries', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const ctx = ctxOf(req)
    return {
      libraries: ctx.principal
        ? campaignRepo.listLibrariesForAdmin(ctx.tenant)
        : campaignRepo.listLibraries(workspaceOf(req))
    }
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
      return reply.code(400).send({ error: '平台不支持建库（支持 WhatsApp/Telegram/LINE/KakaoTalk/Messenger/Instagram）' })
    }
    if (!b.contacts) return reply.code(400).send({ error: '名单内容必填' })
    const parsed = normalizeContactList(b.channel, b.contacts, { lineProvider: b.lineProvider })
    if (parsed.contactIds.length === 0) {
      // 把具体原因带给用户，否则只看到"没解析出"根本不知道该怎么改
      const why = parsed.errors.slice(0, 3).join('；')
      const more = parsed.errors.length > 3 ? ` 等 ${parsed.errors.length} 行` : ''
      return reply.code(400).send({ error: `没有解析出有效标识：${why}${more}`, detail: parsed })
    }
    const tenant = workspaceOf(req)
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
      return reply.code(400).send({ error: '平台不支持建库（支持 WhatsApp/Telegram/LINE/KakaoTalk/Messenger/Instagram）' })
    }
    const r = campaignRepo.exportToLibrary(workspaceOf(req), b.name.trim(), b.channel, {
      accountIds: b.accountIds,
      from: b.from,
      to: b.to
    })
    return r
  })

  /** 追加名单到已有库 */
  app.post('/api/fan-libraries/:id/entries', async (req, reply) => {
    if (!requireCampaign(req, reply)) return
    const id = (req.params as { id: string }).id
    const tenant = libraryWorkspace(req, reply, id)
    if (tenant === null) return
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
    const id = (req.params as { id: string }).id
    const tenant = libraryWorkspace(req, reply, id)
    if (tenant === null) return
    const ok = campaignRepo.deleteLibrary(tenant, id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
  })

  // ── 公开看板（无需登录，靠不可猜的令牌）──
  // ⚠️ 这里只允许返回聚合数字。任何粉丝身份信息、聊天内容都不得出现。
  const requirePublicPassword = (req: FastifyRequest, reply: FastifyReply, tenant: string, campaign: Campaign): boolean => {
    if (!campaign.accessPasswordEnabled) return true
    const password = String((req.query as { password?: string }).password ?? '')
    if (!password) {
      void reply.code(401).send({ error: 'password_required' })
      return false
    }
    if (!campaignRepo.verifyAccessPassword(tenant, campaign, password)) {
      void reply.code(401).send({ error: 'password_invalid' })
      return false
    }
    return true
  }

  /** 粉丝身份明细和逐账号趋势必须受工单级开关保护，不能只靠网页隐藏按钮。 */
  const requirePublicFanData = (reply: FastifyReply, campaign: Campaign): boolean => {
    if (campaign.allowFanData) return true
    void reply.code(403).send({ error: 'fan_data_disabled' })
    return false
  }

  app.get('/public/campaign/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ error: r.reason })
    // 地区限制：默认拒绝中国大陆与香港 IP，老板可在工单设置里逐项放开
    if (!regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })) {
      return reply.code(403).send({ error: 'region_blocked' })
    }
    if (!requirePublicPassword(req, reply, r.tenant, r.campaign)) return
    const password = String((req.query as { password?: string }).password ?? '')
    const stats = campaignRepo.statsOf(r.tenant, r.campaign)
    const campaignType =
      Object.values(r.campaign.accountProfiles ?? {}).find((profile) => profile?.channel)?.channel ||
      stats.byAccount.find((row) => row.channel)?.channel ||
      ''
    const homepage = (channel: string, handle?: string): string => {
      if (!handle?.trim()) return ''
      if (channel === 'whatsapp') return `https://wa.me/${handle.replace(/\D/g, '')}`
      if (channel === 'telegram' || channel === 'telegram_bot') return `https://t.me/${handle.replace(/^@/, '')}`
      if (channel === 'line') return `https://line.me/R/oaMessage/${encodeURIComponent(handle.startsWith('@') ? handle : `@${handle}`)}/`
      return ''
    }
    const publicStats = {
      ...stats,
      // 原始媒体 ID 不直接暴露；头像通过同一分享令牌保护的只读路由读取。
      byAccount: await Promise.all(stats.byAccount.map(async ({ avatarMediaId, ...row }) => {
        const homepageUrl = homepage(row.channel, row.handle)
        return {
          ...row,
          target: r.campaign.accountTargets[row.accountId] ?? 0,
          ...(avatarMediaId ? { avatarUrl: `/public/campaign/${encodeURIComponent(token)}/media/${encodeURIComponent(avatarMediaId)}${password ? `?password=${encodeURIComponent(password)}` : ''}` } : {}),
          ...(homepageUrl ? { homepageUrl, homepageQrDataUrl: await QRCode.toDataURL(homepageUrl, { width: 128, margin: 1 }) } : {})
        }
      }))
    }
    return {
      campaign: {
        id: r.campaign.id,
        name: r.campaign.name,
        type: campaignType,
        createdAt: r.campaign.createdAt,
        resetTime: `${r.campaign.resetTime}:00`,
        totalTarget: r.campaign.totalTarget,
        accessPasswordEnabled: r.campaign.accessPasswordEnabled,
        allowFanData: r.campaign.allowFanData,
        accountTargets: r.campaign.accountTargets,
        startAt: r.campaign.startAt,
        endAt: r.campaign.endAt,
        tzOffsetMinutes: r.campaign.tzOffsetMinutes,
        // 判重口径要让看的人知道，但只给数量不给库内容
        dedup: {
          libraries: r.campaign.dedupLibraryIds.length,
          beforeAt: r.campaign.dedupBeforeAt
        }
      },
      stats: publicStats
    }
  })

  app.get('/public/campaign/:token/account/:accountId/fans', async (req, reply) => {
    const { token, accountId } = req.params as { token: string; accountId: string }
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ error: r.reason })
    if (!regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })) return reply.code(403).send({ error: 'region_blocked' })
    if (!requirePublicPassword(req, reply, r.tenant, r.campaign)) return
    if (!requirePublicFanData(reply, r.campaign)) return
    return { fans: campaignRepo.accountFansOf(r.tenant, r.campaign, accountId) }
  })

  /**
   * 第三方同步 API：返回工单账号及聚合统计，结构兼容同行常用格式。
   * 访问凭分享链接 token；不返回粉丝身份或聊天内容。
   */
  app.get('/public/campaign/:token/accounts', async (req, reply) => {
    const { token } = req.params as { token: string }
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ code: 404, error: r.reason })
    if (!regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })) {
      return reply.code(403).send({ code: 403, error: 'region_blocked' })
    }
    if (!requirePublicPassword(req, reply, r.tenant, r.campaign)) return
    const stats = campaignRepo.statsOf(r.tenant, r.campaign)
    const data = stats.byAccount.map((row) => ({
      id: row.accountId,
      nickname: row.label || row.accountId,
      user: row.handle || '',
      online: row.status === 'online' ? 1 : 0,
      sum: row.total,
      day_sum: row.dayTotal
    }))
    const sum = data.reduce((total, row) => total + row.sum, 0)
    const daySum = data.reduce((total, row) => total + row.day_sum, 0)
    return {
      code: 0,
      data,
      count: data.length,
      totalRow: { id: '总计：', day_sum: String(daySum), sum: String(sum) }
    }
  })

  app.get('/public/campaign/:token/account/:accountId/trend', async (req, reply) => {
    const { token, accountId } = req.params as { token: string; accountId: string }
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ error: r.reason })
    if (!regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })) return reply.code(403).send({ error: 'region_blocked' })
    if (!requirePublicPassword(req, reply, r.tenant, r.campaign)) return
    if (!requirePublicFanData(reply, r.campaign)) return
    return { days: campaignRepo.accountTrendOf(r.tenant, r.campaign, accountId) }
  })

  // 分享页头像：必须同时持有有效分享令牌和通过地区限制，不能借此绕过公开看板权限。
  app.get('/public/campaign/:token/media/:mediaId', async (req, reply) => {
    const { token, mediaId } = req.params as { token: string; mediaId: string }
    const r = campaignRepo.resolveLink(token)
    if (!r.ok) return reply.code(404).send({ error: r.reason })
    if (!regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })) {
      return reply.code(403).send({ error: 'region_blocked' })
    }
    if (!requirePublicPassword(req, reply, r.tenant, r.campaign)) return
    if (!/^[\w.\-]+$/.test(mediaId)) return reply.code(400).send({ error: 'bad id' })
    const campaignAvatarIds = new Set(
      Object.values(r.campaign.accountProfiles ?? {})
        .map((profile) => profile?.avatarMediaId)
        .filter((id): id is string => typeof id === 'string')
    )
    if (!campaignAvatarIds.has(mediaId)) return reply.code(404).send({ error: 'not found' })
    const record = repo.getMedia(r.tenant, mediaId)
    if (!record) return reply.code(404).send({ error: 'not found' })
    reply.type(record.mimeType || 'application/octet-stream')
    return reply.send(createReadStream(record.path))
  })

  // 分享页本体：独立静态页，收件人打开一个 URL 就能看
  app.get('/c/:token', async (req, reply) => {
    // 页面本身也拦：避免先展示壳子再由接口报 403 的体验
    const r = campaignRepo.resolveLink((req.params as { token: string }).token)
    if (
      r.ok &&
      !regionAllowed(req.ip, { allowCn: r.campaign.allowCnIp, allowHk: r.campaign.allowHkIp })
    ) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><meta charset="utf-8"><title>403</title><p style="font-family:system-ui;text-align:center;margin-top:20vh">该链接在你所在的地区不可访问</p>')
    }
    return reply.type('text/html; charset=utf-8').send(await readDashboardHtml())
  })

  // ── 代理供应商目录（需 billing:manage）──
  // 商业链接由后台统一维护，客户端只能读取已上架项目，便于随时换官网或渠道链接。
  app.get('/api/admin/proxy-vendors', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    return { vendors: proxyVendors.list(config.clientTenant) }
  })

  app.post('/api/admin/proxy-vendors', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    try {
      return {
        vendor: proxyVendors.create(
          config.clientTenant,
          parseProxyVendorInput(req.body, false) as ProxyVendorInput
        )
      }
    } catch (error) {
      return reply.code(400).send({ error: validationMessage(error) })
    }
  })

  app.patch('/api/admin/proxy-vendors/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    try {
      const ok = proxyVendors.update(
        config.clientTenant,
        (req.params as { id: string }).id,
        parseProxyVendorInput(req.body, true)
      )
      return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
    } catch (error) {
      return reply.code(400).send({ error: validationMessage(error) })
    }
  })

  app.delete('/api/admin/proxy-vendors/:id', async (req, reply) => {
    if (!requirePerm(req, reply, 'billing:manage')) return
    const ok = proxyVendors.delete(config.clientTenant, (req.params as { id: string }).id)
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' })
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

  app.get('/api/admin/campaign-share-domain', async (req, reply) => {
    if (!requirePerm(req, reply, 'campaigns:manage')) return
    return { domain: repo.getTenantSetting(ctxOf(req).tenant, 'campaignShareDomain') || (config.campaignShareDomain || config.publicUrl).replace(/\/$/, '') }
  })

  app.put('/api/admin/campaign-share-domain', async (req, reply) => {
    if (!requirePerm(req, reply, 'campaigns:manage')) return
    const domain = String((req.body as { domain?: unknown } | undefined)?.domain ?? '').trim().replace(/\/$/, '')
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(domain)) {
      return reply.code(400).send({ error: '分享域名必须是完整的 http(s) URL' })
    }
    repo.setTenantSetting(ctxOf(req).tenant, 'campaignShareDomain', domain)
    return { domain }
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
    // 套餐定向公告按计费主体判定：客服跟老板的套餐走
    const sub = billingRepo.getSubscription(ctx.tenant, ctx.billingUserId ?? ctx.clientUserId)
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
    const ctx = ctxOf(req)
    const record = ctx.principal
      ? repo.getMediaForAdmin(ctx.tenant, mediaId)
      : repo.getMedia(workspaceOf(req), mediaId)
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
    const tenant = resolvedWorkspace(req, reply, () => repo.conversationWorkspacesForAdmin(ctxOf(req).tenant, id))
    if (tenant === null) return
    const messages = repo.listMessages(tenant, id, 500)
    const analysis = await analyzer.analyze(messages)
    // 按需深度分析的结果也落库，覆盖关键词自动标签（更准）
    let newestInbound = 0
    for (const m of messages) if (m.direction === 'in' && m.timestamp > newestInbound) newestInbound = m.timestamp
    intentRepo.put(tenant, id, analysis, newestInbound)
    return { analysis }
  })

  app.post('/api/analyze/contact/:contactId', async (req, reply) => {
    if (!requirePerm(req, reply, 'analyze:run')) return
    if (!analyzer) return reply.code(501).send({ error: 'AI 分析未配置（缺少 ANTHROPIC_API_KEY）' })
    const contactId = decodeURIComponent((req.params as { contactId: string }).contactId)
    const tenant = resolvedWorkspace(req, reply, () => repo.contactWorkspacesForAdmin(ctxOf(req).tenant, contactId))
    if (tenant === null) return
    const messages = repo.messagesByContact(tenant, contactId)
    return { analysis: await analyzer.analyze(messages) }
  })

  return app
}

const WORKSPACE_CHANNELS = new Set([
  'whatsapp', 'telegram', 'telegram_bot', 'line', 'kakaotalk',
  'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
])

function parseAccountIdentity(accountKey: string): { channel: string; accountId: string } | null {
  const separator = accountKey.indexOf(':')
  if (separator <= 0) return null
  const channel = accountKey.slice(0, separator)
  const accountId = accountKey.slice(separator + 1)
  if (!WORKSPACE_CHANNELS.has(channel) || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) return null
  return { channel, accountId }
}

function validAccountIdentity(accountKey: string, channel?: string, accountId?: string): boolean {
  const parsed = parseAccountIdentity(accountKey)
  return !!parsed && parsed.channel === channel && parsed.accountId === accountId
}

function cleanOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().slice(0, max)
  return cleaned || undefined
}

function parseProxyVendorInput(body: unknown, partial: boolean): Partial<ProxyVendorInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求内容格式错误')
  const source = body as Record<string, unknown>
  const result: Partial<ProxyVendorInput> = {}
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key)

  if (!partial || has('name')) {
    if (typeof source.name !== 'string' || !source.name.trim()) throw new Error('供应商名称必填')
    if (source.name.trim().length > 80) throw new Error('供应商名称不能超过 80 个字符')
    result.name = source.name.trim()
  }
  if (!partial || has('region')) {
    if (!isProxyVendorRegion(source.region)) throw new Error('地区分类必须是 global 或 china')
    result.region = source.region
  }
  if (!partial || has('purchaseUrl')) {
    result.purchaseUrl = normalizeCatalogUrl(source.purchaseUrl, true)
  }
  if (has('logoUrl')) result.logoUrl = normalizeCatalogUrl(source.logoUrl, false)
  if (has('summary') || !partial) result.summary = cleanCatalogText(source.summary, 240)
  if (has('badge') || !partial) result.badge = cleanCatalogText(source.badge, 24)
  if (has('buttonLabel') || !partial) {
    const label = cleanCatalogText(source.buttonLabel, 20)
    result.buttonLabel = label || '立即访问'
  }
  if (has('enabled')) {
    if (typeof source.enabled !== 'boolean') throw new Error('上架状态格式错误')
    result.enabled = source.enabled
  } else if (!partial) result.enabled = true
  if (has('recommended')) {
    if (typeof source.recommended !== 'boolean') throw new Error('推荐状态格式错误')
    result.recommended = source.recommended
  } else if (!partial) result.recommended = false
  if (has('sortOrder')) {
    const order = Number(source.sortOrder)
    if (!Number.isFinite(order)) throw new Error('排序必须是数字')
    result.sortOrder = Math.max(-100_000, Math.min(100_000, Math.round(order)))
  } else if (!partial) result.sortOrder = 0
  return result
}

function normalizeCatalogUrl(value: unknown, required: boolean): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    if (required) throw new Error('购买链接必填')
    return ''
  }
  if (raw.length > 2_048) throw new Error('链接过长')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('链接必须是完整的 http(s) URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('链接必须是 http(s) URL')
  }
  return parsed.toString()
}

function cleanCatalogText(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('文本字段格式错误')
  return value.trim().slice(0, max)
}

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : '参数错误'
}

/** 极简、无脚本的 OAuth 完成页。选择项只带随机 state 和资产 ID，不携带任何访问令牌。 */
function metaOauthHtml(result: MetaOauthResult, state?: string): string {
  const ok = result.status !== 'error'
  const choices = result.status === 'selecting' && state
    ? `<div class="choices">${(result.resources ?? []).map((resource) => {
        const subtitle = resource.handle ? `@${escapeHtml(resource.handle)}` : escapeHtml(resource.id)
        const href = `/oauth/meta/select?state=${encodeURIComponent(state)}&resource=${encodeURIComponent(resource.id)}`
        return `<a href="${href}"><strong>${escapeHtml(resource.name)}</strong><span>${subtitle}</span></a>`
      }).join('')}</div>`
    : ''
  const closeHint = result.status === 'connected'
    ? `<p class="hint">可以关闭本页并返回 ${escapeHtml(brand.appName)}，客户端会自动连接。</p>`
    : result.status === 'error'
      ? `<p class="hint">请返回 ${escapeHtml(brand.appName)} 重新发起授权；若仍失败，请检查 Meta 应用权限与回调地址。</p>`
      : '<p class="hint">选择后会立即完成连接。</p>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(brand.appName)} Meta 授权</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#172033;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.card{width:min(560px,100%);background:#fff;border:1px solid #e5e9f0;border-radius:20px;box-shadow:0 18px 50px #24324a1a;padding:34px}.mark{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:${ok ? '#e8f8ef' : '#fff0f0'};color:${ok ? '#168a4f' : '#c73939'};font-size:28px;font-weight:700}h1{font-size:23px;margin:20px 0 8px}p{margin:0}.hint{color:#667085;margin-top:12px}.choices{display:grid;gap:10px;margin-top:22px}.choices a{text-decoration:none;color:inherit;border:1px solid #dce3ee;border-radius:13px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;transition:.15s}.choices a:hover{border-color:#1877f2;background:#f5f9ff}.choices span{color:#697386;font-size:14px}</style></head><body><main class="card"><div class="mark">${ok ? '✓' : '!'}</div><h1>${escapeHtml(result.status === 'selecting' ? '选择要接入的账号' : ok ? '授权完成' : '授权失败')}</h1><p>${escapeHtml(result.message)}</p>${choices}${closeHint}</main></body></html>`
}

/** TikTok OAuth 完成页不运行脚本，也不回显 code、token 或业务账号内部 ID。 */
function tiktokOauthHtml(result: TikTokOauthResult): string {
  const ok = result.status === 'connected'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(brand.appName)} TikTok 授权</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#172033;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.card{width:min(520px,100%);background:#fff;border:1px solid #e5e9f0;border-radius:20px;box-shadow:0 18px 50px #24324a1a;padding:34px}.mark{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:${ok ? '#e8f8ef' : '#fff0f0'};color:${ok ? '#168a4f' : '#c73939'};font-size:28px;font-weight:700}h1{font-size:23px;margin:20px 0 8px}p{margin:0}.hint{color:#667085;margin-top:12px}</style></head><body><main class="card"><div class="mark">${ok ? '✓' : '!'}</div><h1>${ok ? 'TikTok 授权完成' : 'TikTok 授权失败'}</h1><p>${escapeHtml(result.message)}</p><p class="hint">${ok ? `可以关闭本页并返回 ${escapeHtml(brand.appName)}，客户端会自动连接。` : `请返回 ${escapeHtml(brand.appName)} 重新发起授权，并检查企业号及应用审核状态。`}</p></main></body></html>`
}

/** X / Snapchat 共用的无脚本 OAuth 结果页；不会回显 code 或任何令牌。 */
function oauthResultHtml(provider: 'X' | 'Snapchat', result: XOauthResult | SnapchatOauthResult): string {
  const ok = result.status === 'connected'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(brand.appName)} ${provider} 授权</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#172033;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.card{width:min(520px,100%);background:#fff;border:1px solid #e5e9f0;border-radius:20px;box-shadow:0 18px 50px #24324a1a;padding:34px}.mark{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:${ok ? '#e8f8ef' : '#fff0f0'};color:${ok ? '#168a4f' : '#c73939'};font-size:28px;font-weight:700}h1{font-size:23px;margin:20px 0 8px}p{margin:0}.hint{color:#667085;margin-top:12px}</style></head><body><main class="card"><div class="mark">${ok ? '✓' : '!'}</div><h1>${provider} 授权${ok ? '完成' : '失败'}</h1><p>${escapeHtml(result.message)}</p><p class="hint">${ok ? `可以关闭本页并返回 ${escapeHtml(brand.appName)}，客户端会自动连接。` : `请返回 ${escapeHtml(brand.appName)} 重新发起授权，并检查应用权限与审核状态。`}</p></main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]!)
}
