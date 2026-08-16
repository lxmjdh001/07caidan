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
}

export function loadConfig(): ServerConfig {
  const dataDir = process.env.OMNI_DATA_DIR || join(process.cwd(), 'data')
  return {
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.OMNI_DB_PATH || join(dataDir, 'omnichat.db'),
    mediaDir: process.env.OMNI_MEDIA_DIR || join(dataDir, 'media'),
    tokens: (process.env.OMNI_TOKENS || 'dev-token')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    analysisModel: process.env.OMNI_ANALYSIS_MODEL || 'claude-opus-5'
  }
}
