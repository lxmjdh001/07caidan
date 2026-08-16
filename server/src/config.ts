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
      `http://localhost:${Number(process.env.PORT || 8787)}`
  }
}
