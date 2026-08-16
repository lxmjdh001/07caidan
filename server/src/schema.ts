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
