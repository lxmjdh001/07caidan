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

/** LINE 账号注册（客户端把 channelSecret 存到后台用于 Webhook 验签） */
export const lineAccounts = sqliteTable('line_accounts', {
  tenant: text('tenant').notNull(),
  accountId: text('account_id').notNull(),
  channelSecret: text('channel_secret').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [primaryKey({ columns: [t.tenant, t.accountId] })])

/** LINE Webhook 事件队列（客户端轮询拉取后删除） */
export const lineEvents = sqliteTable('line_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  accountId: text('account_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_line_events').on(t.tenant, t.accountId)])

/**
 * 工单（引流任务）：一组账号 + 起止时间 + 判重规则。
 * 统计结果不落库，按需从 conversations/messages 现算（见 CampaignRepo）。
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** JSON 字符串：参与账号 accountId 数组 */
    accountIds: text('account_ids').notNull().default('[]'),
    /** JSON 字符串：accountId → 备注名。账号是老板自己的，可在看板展示 */
    accountLabels: text('account_labels').notNull().default('{}'),
    startAt: integer('start_at').notNull(),
    /** 空 = 持续进行 */
    endAt: integer('end_at'),
    /** JSON 字符串：选中的重粉库 id 数组 */
    dedupLibraryIds: text('dedup_library_ids').notNull().default('[]'),
    /** 该时间之前出现过即算重复；空 = 不启用时间规则 */
    dedupBeforeAt: integer('dedup_before_at'),
    /** 看板时区偏移（分钟），默认 UTC+8 */
    tzOffsetMinutes: integer('tz_offset_minutes').notNull().default(480),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 工单的公开分享链接；一个工单可有多条，各自独立设置有效期 */
export const campaignLinks = sqliteTable(
  'campaign_links',
  {
    /** 分享令牌，同时是主键（公开 URL 里的那一段） */
    token: text('token').primaryKey(),
    tenant: text('tenant').notNull(),
    campaignId: text('campaign_id').notNull(),
    /** 备注（发给谁的） */
    label: text('label'),
    /** 空 = 永不过期 */
    expiresAt: integer('expires_at'),
    /** 手动失效，立即生效 */
    revoked: integer('revoked').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('idx_links_campaign').on(t.tenant, t.campaignId)]
)

/**
 * 重粉库：一组历史客户标识。不同平台的库互相独立（channel 字段），
 * 创建工单时只能选同平台的库。
 */
export const fanLibraries = sqliteTable(
  'fan_libraries',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** whatsapp / telegram / telegram_bot / line */
    channel: text('channel').notNull(),
    /** export=从系统历史数据导出，import=外部导入 */
    source: text('source').notNull(),
    /** 条目数（冗余，列表展示用） */
    entryCount: integer('entry_count').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

export const fanLibraryEntries = sqliteTable(
  'fan_library_entries',
  {
    tenant: text('tenant').notNull(),
    libraryId: text('library_id').notNull(),
    contactId: text('contact_id').notNull(),
    addedAt: integer('added_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.libraryId, t.contactId] }),
    index('idx_fan_entries_contact').on(t.tenant, t.contactId)
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
