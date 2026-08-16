import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema（SQLite）。切换到 PostgreSQL 时改用 pg-core 的同名表定义，
 * Repo 查询逻辑基本不变。所有表按 tenant 隔离，业务键幂等。
 */

export const conversations = sqliteTable(
  'conversations',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    channel: text('channel').notNull(),
    accountId: text('account_id').notNull(),
    contactId: text('contact_id'),
    title: text('title').notNull(),
    isGroup: integer('is_group').notNull().default(0),
    lastMessageAt: integer('last_message_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] }), index('idx_conv_contact').on(t.tenant, t.contactId)]
)

export const messages = sqliteTable(
  'messages',
  {
    tenant: text('tenant').notNull(),
    externalId: text('external_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    channel: text('channel').notNull(),
    accountId: text('account_id').notNull(),
    direction: text('direction').notNull(),
    authorName: text('author_name'),
    bodyType: text('body_type').notNull(),
    text: text('text'),
    mediaType: text('media_type'),
    mediaId: text('media_id'),
    mimeType: text('mime_type'),
    fileName: text('file_name'),
    caption: text('caption'),
    durationSec: integer('duration_sec'),
    translationText: text('translation_text'),
    translationLang: text('translation_lang'),
    timestamp: integer('timestamp').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.externalId] }),
    index('idx_messages_conv').on(t.tenant, t.conversationId, t.timestamp)
  ]
)

/** 管理后台用户（RBAC）：角色 + 可直接分配的权限列表 */
export const adminUsers = sqliteTable('admin_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
  /** JSON 字符串：权限 key 数组，覆盖/补充角色预设 */
  permissions: text('permissions').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull()
})

/** 登录会话（DB 持久化，可撤销） */
export const sessions = sqliteTable('admin_sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull()
})

/** 客户端用户（桌面端登录账号，邮箱+密码，绑定其数据租户） */
export const clientUsers = sqliteTable('client_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  verified: integer('verified').notNull().default(0),
  createdAt: integer('created_at').notNull()
})

/** 客户端登录会话（token 同时作为同步凭证） */
export const clientSessions = sqliteTable('client_sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull()
})

/** 邮箱验证码 */
export const emailCodes = sqliteTable('email_codes', {
  email: text('email').primaryKey(),
  code: text('code').notNull(),
  expiresAt: integer('expires_at').notNull()
})

export const media = sqliteTable(
  'media',
  {
    tenant: text('tenant').notNull(),
    mediaId: text('media_id').notNull(),
    mimeType: text('mime_type'),
    path: text('path').notNull(),
    size: integer('size').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.mediaId] })]
)
