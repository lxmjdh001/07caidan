import { join } from 'node:path'

export interface ServerConfig {
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
  /**
   * Fastify trustProxy：置真后 req.ip 取自 X-Forwarded-For（反代传来的真实客户端 IP）。
   * 公开看板的地区限制靠 req.ip 判属地——若前置 Caddy/nginx 终止 TLS 而这里不信任代理，
   * req.ip 会是回环地址，地区限制形同虚设。仅当本服务只被同机反代访问时开启（否则 XFF 可伪造）。
   * 取值：'true'→true（信任所有跳）；'loopback'/'127.0.0.1'/网段/跳数→原样透传给 proxy-addr；空→false。
   * 可选：省略等同 false（直连，不信任 XFF）。loadConfig 总会显式赋值。
   */
  trustProxy?: boolean | string | number
  /** 客户端自动更新产物目录（latest*.yml + 安装包）；发布 = 把文件拷进来 */
  updatesDir: string
  /** Crisp 在线客服 Website ID；未配置则客户端隐藏在线客服入口 */
  crispWebsiteId: string | undefined
}

export function loadConfig(): ServerConfig {
  const dataDir = process.env.OMNI_DATA_DIR || join(process.cwd(), 'data')
  const tokens = (process.env.OMNI_TOKENS || 'dev-token')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  return {
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
          from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@omnichat'
        }
      : undefined,
    publicUrl:
      process.env.OMNI_PUBLIC_URL ||
      `http://localhost:${Number(process.env.PORT || 8787)}`,
    trustProxy: parseTrustProxy(process.env.OMNI_TRUST_PROXY),
    updatesDir: process.env.OMNI_UPDATES_DIR || join(dataDir, 'updates'),
    crispWebsiteId: process.env.OMNI_CRISP_WEBSITE_ID || undefined
  }
}

/**
 * 解析 OMNI_TRUST_PROXY：空/未设→false（安全默认，直连时 XFF 不可信）；
 * 'true'/'1'→true；'false'/'0'→false；其余非空值（'loopback'、'127.0.0.1'、'10.0.0.0/8'、跳数）原样透传。
 * 纯数字字符串转成跳数（proxy-addr 语义）。
 */
export function parseTrustProxy(raw: string | undefined): boolean | string | number {
  const v = (raw ?? '').trim()
  if (!v) return false
  const low = v.toLowerCase()
  if (low === 'true' || low === '1') return true
  if (low === 'false' || low === '0') return false
  if (/^\d+$/.test(v)) return Number(v)
  return v
}
