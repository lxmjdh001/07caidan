import type { Config } from 'drizzle-kit'

/** drizzle-kit 配置：生成/推送迁移。切换 Postgres 时改 dialect + dbCredentials。 */
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.OMNI_DB_PATH || './data/omnichat.db' }
} satisfies Config
