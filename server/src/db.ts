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
      is_group INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER NOT NULL DEFAULT 0,
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
      verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `)

  return drizzle(sqlite, { schema })
}
