import { join } from 'node:path'

export interface ServerConfig {
  /** 是否以生产模式运行；影响安全默认值，测试/本地开发可省略。 */
  production?: boolean
  /** 是否启用公网接口与登录限流；仅 NODE_ENV=test 时由加载器关闭。 */
  rateLimitsEnabled?: boolean
  port: number
  host: string
  /** SQLite 文件路径 */
  dbPath: string
  /** 媒体文件存储目录 */
  mediaDir: string
  /**
   * 客户端同步鉴权令牌（多客户端逗号分隔）。
   * 生产环境应换成用户/设备体系（M5 Better Auth）。
   */
  tokens: string[]
  /** Anthropic API Key（缺失则 AI 分析接口返回 501） */
  anthropicApiKey: string | undefined
  /** 实时自动打标签开关（缺省 false） */
  autoTag?: boolean
  /** 意向分析使用的模型 */
  analysisModel: string
  /** 管理后台登录账号 */
  adminUser: string
  /** 管理后台登录密码 */
  adminPassword: string
  /** 管理员登录后可见的租户（默认第一个同步令牌所属租户） */
  adminTenant: string
  /** 客户端注册是否需要邮箱验证码 */
  requireEmailVerify: boolean
  /** 客户端用户所属租户（其同步数据落到这里；默认与 adminTenant 同，供管理后台统一查看） */
  clientTenant: string
  /** SMTP 配置；未配置则开发模式（验证码打日志） */
  smtp: { host: string; port: number; user: string; pass: string; from: string } | undefined
  /** 对外可访问的公网地址（生成 LINE Webhook 地址用） */
  publicUrl: string
  /** 工单分享页公网域名；可由管理后台覆盖 */
  campaignShareDomain?: string
  /**
   * Fastify trustProxy：置真后 req.ip 取自 X-Forwarded-For（反代传来的真实客户端 IP）。
   * 公开看板的地区限制靠 req.ip 判属地——若前置 Caddy/nginx 终止 TLS 而这里不信任代理，
   * req.ip 会是回环地址，地区限制形同虚设。仅当本服务只被同机反代访问时开启（否则 XFF 可伪造）。
   * 取值：'true'→true（信任所有跳）；'loopback'/'127.0.0.1'/网段→原样透传给 proxy-addr；空→false。
   * 不接受“信任 N 跳”的数字模式：客户端可通过补造 X-Forwarded-For 绕过跳数判断。
   * 可选：省略等同 false（直连，不信任 XFF）。loadConfig 总会显式赋值。
   */
  trustProxy?: boolean | string
  /** 允许跨域访问 API 的浏览器 Origin；生产环境应显式列出，留空即不开放跨域。 */
  corsOrigins?: string[]
  /** 客户端自动更新产物目录（latest*.yml + 安装包）；发布 = 把文件拷进来 */
  updatesDir: string
  /** Crisp 在线客服 Website ID；未配置则客户端隐藏在线客服入口 */
  crispWebsiteId: string | undefined
  /** Meta 应用凭证：集中配置一次，客户只走 Facebook 网页授权。 */
  metaAppId?: string
  metaAppSecret?: string
  /** Instagram API with Instagram Login 使用独立的 Instagram App ID/Secret。 */
  metaInstagramAppId?: string
  metaInstagramAppSecret?: string
  /** Meta Webhooks 后台配置时填写的自定义校验串。 */
  metaWebhookVerifyToken?: string
  /** Facebook Login for Business 的配置 ID；未填时使用标准 OAuth scope。 */
  metaLoginConfigId?: string
  /** Meta Page Access Token 的静态加密密钥；至少 32 个随机字符。 */
  metaTokenEncryptionKey?: string
  /** 固定 Graph API 版本，避免 Meta 默认版本自动漂移。 */
  metaGraphVersion?: string
  /** TikTok API for Business 应用凭证；客户只走网页 OAuth 授权。 */
  tiktokAppId?: string
  tiktokAppSecret?: string
  /** TikTok access/refresh token 的静态加密密钥；至少 32 个随机字符。 */
  tiktokTokenEncryptionKey?: string
  /** X OAuth 2.0 应用凭证；客户只需在 X 网页确认授权。 */
  xClientId?: string
  xClientSecret?: string
  /** X access/refresh token 的静态加密密钥；至少 32 个随机字符。 */
  xTokenEncryptionKey?: string
  /** Snapchat Public Profile API 应用凭证。 */
  snapchatClientId?: string
  snapchatClientSecret?: string
  /** Snapchat access/refresh/conversation token 的静态加密密钥。 */
  snapchatTokenEncryptionKey?: string
}

export function loadConfig(): ServerConfig {
  const production = process.env.NODE_ENV === 'production'
  const dataDir = process.env.OMNI_DATA_DIR || join(process.cwd(), 'data')
  const tokens = (process.env.OMNI_TOKENS || 'dev-token')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  return {
    production,
    rateLimitsEnabled: process.env.NODE_ENV !== 'test',
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.OMNI_DB_PATH || join(dataDir, 'omnichat.db'),
    mediaDir: process.env.OMNI_MEDIA_DIR || join(dataDir, 'media'),
    tokens,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    analysisModel: process.env.OMNI_ANALYSIS_MODEL || 'claude-opus-5',
    /** 实时自动打标签：新入站消息触发意向重算（有 key 用 Claude，否则用关键词兜底） */
    autoTag: process.env.OMNI_AUTO_TAG === 'true',
    adminUser: process.env.OMNI_ADMIN_USER || 'admin',
    adminPassword: process.env.OMNI_ADMIN_PASSWORD || 'admin',
    adminTenant: process.env.OMNI_ADMIN_TENANT || tokens[0] || 'dev-token',
    requireEmailVerify: process.env.OMNI_REQUIRE_EMAIL_VERIFY === 'true',
    clientTenant:
      process.env.OMNI_CLIENT_TENANT || process.env.OMNI_ADMIN_TENANT || tokens[0] || 'dev-token',
    smtp: process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
          from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@wzzapp.cloud'
        }
      : undefined,
    publicUrl:
      process.env.OMNI_PUBLIC_URL ||
      `http://localhost:${Number(process.env.PORT || 8787)}`,
    campaignShareDomain:
      process.env.OMNI_CAMPAIGN_SHARE_DOMAIN || process.env.OMNI_PUBLIC_URL || 'https://wzzapp.cloud',
    trustProxy: parseTrustProxy(process.env.OMNI_TRUST_PROXY),
    corsOrigins: parseCorsOrigins(process.env.OMNI_CORS_ORIGINS, production),
    updatesDir: process.env.OMNI_UPDATES_DIR || join(dataDir, 'updates'),
    crispWebsiteId: process.env.OMNI_CRISP_WEBSITE_ID || undefined,
    metaAppId: process.env.META_APP_ID || undefined,
    metaAppSecret: process.env.META_APP_SECRET || undefined,
    metaInstagramAppId: process.env.META_INSTAGRAM_APP_ID || undefined,
    metaInstagramAppSecret: process.env.META_INSTAGRAM_APP_SECRET || undefined,
    metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || undefined,
    metaLoginConfigId: process.env.META_LOGIN_CONFIG_ID || undefined,
    metaTokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || undefined,
    metaGraphVersion: /^v\d+\.0$/.test(process.env.META_GRAPH_VERSION || '')
      ? process.env.META_GRAPH_VERSION
      : 'v26.0',
    tiktokAppId: process.env.TIKTOK_APP_ID || undefined,
    tiktokAppSecret: process.env.TIKTOK_APP_SECRET || undefined,
    tiktokTokenEncryptionKey: process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || undefined,
    xClientId: process.env.X_CLIENT_ID || undefined,
    xClientSecret: process.env.X_CLIENT_SECRET || undefined,
    xTokenEncryptionKey: process.env.X_TOKEN_ENCRYPTION_KEY || undefined,
    snapchatClientId: process.env.SNAPCHAT_CLIENT_ID || undefined,
    snapchatClientSecret: process.env.SNAPCHAT_CLIENT_SECRET || undefined,
    snapchatTokenEncryptionKey: process.env.SNAPCHAT_TOKEN_ENCRYPTION_KEY || undefined
  }
}

const DEVELOPMENT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5198',
  'http://127.0.0.1:5198'
]

/** 生产环境默认关闭跨域；开发环境只允许本机管理后台。 */
export function parseCorsOrigins(raw: string | undefined, production: boolean): string[] {
  if (!raw?.trim()) return production ? [] : [...DEVELOPMENT_CORS_ORIGINS]
  return [...new Set(raw.split(',').map((origin) => origin.trim()).filter(Boolean))]
}

/**
 * 对真正会造成生产暴露或账号失控的配置执行 fail-fast。
 * 可选平台凭证不完整只会让对应平台保持“开发中”，因此不阻止核心三平台启动。
 */
export function productionConfigErrors(config: ServerConfig): string[] {
  const errors: string[] = []
  const weak = /^(?:admin|password|dev-token|change_me)/i
  const loopbackHost = ['127.0.0.1', '::1', 'localhost'].includes(config.host)

  if (!loopbackHost) errors.push('HOST 必须绑定回环地址，由 Caddy 统一对外提供 HTTPS')
  try {
    const publicUrl = new URL(config.publicUrl)
    if (publicUrl.protocol !== 'https:' || !publicUrl.hostname) throw new Error('invalid URL')
  } catch {
    errors.push('OMNI_PUBLIC_URL 必须是有效的 HTTPS 地址')
  }
  if (config.adminPassword.length < 12 || weak.test(config.adminPassword)) {
    errors.push('OMNI_ADMIN_PASSWORD 必须是至少 12 位的非默认密码')
  }
  if (!config.tokens.length || config.tokens.some((token) => token.length < 24 || weak.test(token))) {
    errors.push('OMNI_TOKENS 中每个令牌必须是至少 24 位的随机值')
  }
  if (
    config.requireEmailVerify &&
    (!config.smtp || !config.smtp.host || !config.smtp.user || !config.smtp.pass || !config.smtp.from ||
      !Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65_535)
  ) {
    errors.push('开启邮箱验证时必须完整配置 SMTP')
  }
  if (config.trustProxy && !loopbackHost) {
    errors.push('仅允许在后端绑定回环地址时启用 OMNI_TRUST_PROXY')
  }
  for (const origin of config.corsOrigins ?? []) {
    try {
      const url = new URL(origin)
      if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('invalid origin')
    } catch {
      errors.push(`OMNI_CORS_ORIGINS 包含无效生产来源：${origin}`)
    }
  }
  return errors
}

/**
 * 解析 OMNI_TRUST_PROXY：空/未设→false（安全默认，直连时 XFF 不可信）；
 * 'true'/'1'→true；'false'/'0'→false；其余非空值（'loopback'、'127.0.0.1'、'10.0.0.0/8'）原样透传。
 * 纯数字跳数存在 X-Forwarded-For 欺骗风险，除兼容布尔值 0/1 外统一安全回落为 false。
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const v = (raw ?? '').trim()
  if (!v) return false
  const low = v.toLowerCase()
  if (low === 'true' || low === '1') return true
  if (low === 'false' || low === '0') return false
  if (/^\d+$/.test(v)) return false
  return v
}
