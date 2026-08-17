import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.ts'

export type Db = BetterSQLite3Database<typeof schema>

/**
 * 打开数据库并确保表结构存在。
 * 开发期用 SQLite；生产迁移 PostgreSQL 时换 drizzle/pg 驱动 + drizzle-kit 迁移。
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new BetterSqlite3(dbPath)
  sqlite.pragma('journal_mode = WAL')

  // 首版直接建表（等价于 drizzle 迁移的初始快照）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      tenant TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL,
      account_id TEXT NOT NULL, contact_id TEXT, title TEXT NOT NULL,
      is_group INTEGER NOT NULL DEFAULT 0,
      lead_source_code TEXT, lead_source_via TEXT,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (tenant, id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations (tenant, contact_id);

    CREATE TABLE IF NOT EXISTS messages (
      tenant TEXT NOT NULL, external_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL, account_id TEXT NOT NULL, direction TEXT NOT NULL,
      author_name TEXT, body_type TEXT NOT NULL, text TEXT, media_type TEXT,
      media_id TEXT, mime_type TEXT, file_name TEXT, caption TEXT, duration_sec INTEGER,
      translation_text TEXT, translation_lang TEXT, timestamp INTEGER NOT NULL,
      PRIMARY KEY (tenant, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (tenant, conversation_id, timestamp);

    CREATE TABLE IF NOT EXISTS media (
      tenant TEXT NOT NULL, media_id TEXT NOT NULL, mime_type TEXT,
      path TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (tenant, media_id)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      owner_id INTEGER, role TEXT NOT NULL DEFAULT 'boss',
      permissions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_roles (
      tenant TEXT NOT NULL, id TEXT NOT NULL, owner_id INTEGER NOT NULL,
      name TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS client_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL, user_id INTEGER, device_id TEXT NOT NULL,
      level TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL, meta TEXT,
      app_version TEXT NOT NULL DEFAULT '', os_type TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_logs ON client_logs (tenant, created_at);
    CREATE INDEX IF NOT EXISTS idx_client_logs_device ON client_logs (tenant, device_id, created_at);
    CREATE TABLE IF NOT EXISTS client_log_levels (
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, level TEXT NOT NULL,
      PRIMARY KEY (tenant, user_id)
    );
    CREATE TABLE IF NOT EXISTS client_sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS line_accounts (
      tenant TEXT NOT NULL, account_id TEXT NOT NULL, channel_secret TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (tenant, account_id)
    );
    CREATE TABLE IF NOT EXISTS line_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, account_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_line_events ON line_events (tenant, account_id);

    CREATE TABLE IF NOT EXISTS campaigns (
      tenant TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      account_ids TEXT NOT NULL DEFAULT '[]',
      account_labels TEXT NOT NULL DEFAULT '{}',
      start_at INTEGER NOT NULL, end_at INTEGER,
      dedup_library_ids TEXT NOT NULL DEFAULT '[]', dedup_before_at INTEGER,
      dedup_account_ids TEXT NOT NULL DEFAULT '[]',
      tz_offset_minutes INTEGER NOT NULL DEFAULT 480,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );

    CREATE TABLE IF NOT EXISTS campaign_links (
      token TEXT PRIMARY KEY, tenant TEXT NOT NULL, campaign_id TEXT NOT NULL,
      label TEXT, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_links_campaign ON campaign_links (tenant, campaign_id);

    CREATE TABLE IF NOT EXISTS fan_libraries (
      tenant TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      channel TEXT NOT NULL, source TEXT NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );

    CREATE TABLE IF NOT EXISTS fan_library_entries (
      tenant TEXT NOT NULL, library_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      added_at INTEGER NOT NULL, PRIMARY KEY (tenant, library_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fan_entries_contact ON fan_library_entries (tenant, contact_id);

    CREATE TABLE IF NOT EXISTS plans (
      tenant TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      period_unit TEXT NOT NULL DEFAULT 'month',
      period_count INTEGER NOT NULL DEFAULT 1,
      max_accounts INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
      start_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, user_id)
    );

    CREATE TABLE IF NOT EXISTS balances (
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, user_id)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      credits_delta INTEGER NOT NULL DEFAULT 0,
      balance_after INTEGER NOT NULL, credits_after INTEGER NOT NULL,
      ref_type TEXT, ref_id TEXT, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (tenant, user_id, created_at);

    CREATE TABLE IF NOT EXISTS payment_channels (
      tenant TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}',
      fee_rate TEXT NOT NULL DEFAULT '0', fee_fixed_cents INTEGER NOT NULL DEFAULT 0,
      fee_paid_by TEXT NOT NULL DEFAULT 'merchant',
      currency TEXT NOT NULL DEFAULT 'USD',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      tenant TEXT NOT NULL, currency TEXT NOT NULL, rate TEXT NOT NULL,
      decimals INTEGER NOT NULL DEFAULT 2, updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, currency)
    );

    CREATE TABLE IF NOT EXISTS orders (
      tenant TEXT NOT NULL, id TEXT NOT NULL, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL, plan_id TEXT,
      amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0,
      payable_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', locked_rate TEXT NOT NULL DEFAULT '1',
      payable_local INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT, channel_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, paid_at INTEGER,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (tenant, user_id, created_at);

    CREATE TABLE IF NOT EXISTS announcements (
      tenant TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'all', audience_param TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS announcement_reads (
      tenant TEXT NOT NULL, announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, announcement_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS user_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL,
      read_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notices_user ON user_notices (tenant, user_id, read_at);
    CREATE TABLE IF NOT EXISTS reminder_settings (
      tenant TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      days_before TEXT NOT NULL DEFAULT '7,3,1',
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_subject TEXT NOT NULL DEFAULT '', email_body TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders_sent (
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, threshold INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, user_id, threshold, expires_at)
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      tenant TEXT NOT NULL, id TEXT NOT NULL, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets (tenant, user_id, updated_at);
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL, ticket_id TEXT NOT NULL, sender TEXT NOT NULL,
      sender_name TEXT, body TEXT NOT NULL DEFAULT '', media_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON support_messages (tenant, ticket_id, created_at);

    CREATE TABLE IF NOT EXISTS ai_providers (
      tenant TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );

    CREATE TABLE IF NOT EXISTS ai_models (
      tenant TEXT NOT NULL, id TEXT NOT NULL, provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      purposes TEXT NOT NULL DEFAULT '[]',
      credits_per_million_input INTEGER NOT NULL DEFAULT 0,
      credits_per_million_output INTEGER NOT NULL DEFAULT 0,
      credits_per_audio_second INTEGER NOT NULL DEFAULT 0,
      min_credits INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models (tenant, provider_id);

    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL, user_id INTEGER NOT NULL, model_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      audio_seconds INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user ON model_usage (tenant, user_id, created_at);

    CREATE TABLE IF NOT EXISTS billing_settings (
      tenant TEXT PRIMARY KEY,
      credits_per_usd INTEGER NOT NULL DEFAULT 1000,
      auto_top_up_credits INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
  `)

  migrate(sqlite)

  return drizzle(sqlite, { schema })
}

/**
 * 增量迁移：给已存在的表补新列。
 *
 * 为什么必须有这个：上面用的是 `CREATE TABLE IF NOT EXISTS`，它对**已经存在**的表
 * 什么都不做 —— 新加的列在老库上永远不会出现，升级后一查就是
 * "no such column"。全新库看不出问题（测试每次都建新库），只有升级才会炸。
 *
 * 加新列时在这里追加一行即可；SQLite 的 ADD COLUMN 是 O(1) 的元数据操作，
 * 但要求新列有默认值或可空，因此不要在这里加 NOT NULL 且无默认值的列。
 */
function migrate(sqlite: BetterSqlite3.Database): void {
  const columns = [
    ['campaigns', 'account_labels', `TEXT NOT NULL DEFAULT '{}'`],
    ['campaigns', 'dedup_account_ids', `TEXT NOT NULL DEFAULT '[]'`],
    ['campaigns', 'tz_offset_minutes', 'INTEGER NOT NULL DEFAULT 480'],
    ['conversations', 'lead_source_code', 'TEXT'],
    ['conversations', 'lead_source_via', 'TEXT'],
    ['client_users', 'owner_id', 'INTEGER'],
    ['client_users', 'role', "TEXT NOT NULL DEFAULT 'boss'"],
    ['client_users', 'permissions', "TEXT NOT NULL DEFAULT '[]'"],
    ['client_users', 'enabled', 'INTEGER NOT NULL DEFAULT 1']
  ] as const

  for (const [table, column, definition] of columns) {
    if (!tableExists(sqlite, table) || columnExists(sqlite, table, column)) continue
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function tableExists(sqlite: BetterSqlite3.Database, table: string): boolean {
  return !!sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table)
}

function columnExists(sqlite: BetterSqlite3.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}
