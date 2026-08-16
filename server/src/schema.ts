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
    /** 投放来源标识（广告 id 或追踪码），客户端归因后同步上来 */
    leadSourceCode: text('lead_source_code'),
    /** 归因方式：ad = 平台广告上下文，code = 预填文案追踪码 */
    leadSourceVia: text('lead_source_via'),
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
    /** JSON：时间规则只看这些账号的历史；空数组 = 全部账号 */
    dedupAccountIds: text('dedup_account_ids').notNull().default('[]'),
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

// ══════════ 计费：套餐 / 订阅 / 余额 / 流水 ══════════
// 金额一律存**整数美分（USD）**；本地货币只在下单时换算并锁定汇率。

/** 套餐：价格 + 周期 + 可登录账号数上限 */
export const plans = sqliteTable(
  'plans',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** 价格，单位美分（USD） */
    priceCents: integer('price_cents').notNull().default(0),
    /** month / quarter / half_year / year / day */
    periodUnit: text('period_unit').notNull().default('month'),
    /** 几个周期；unit=day 时表示自定义天数 */
    periodCount: integer('period_count').notNull().default(1),
    /** 可登录的平台账号数上限 */
    maxAccounts: integer('max_accounts').notNull().default(1),
    enabled: integer('enabled').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 用户订阅。一个客户端用户同一时间只有一条生效订阅 */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    planId: text('plan_id').notNull(),
    startAt: integer('start_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** 到期是否自动从余额续费 */
    autoRenew: integer('auto_renew').notNull().default(0),
    /** active / expired / cancelled */
    status: text('status').notNull().default('active'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.userId] })]
)

/**
 * 余额与积分。
 * 这张表是「当前值」，每一次变动都必须同时往 ledger 写一条流水，
 * 且在同一个事务里 —— 对不上账的余额是不可接受的。
 */
export const balances = sqliteTable(
  'balances',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    /** 余额，美分 */
    balanceCents: integer('balance_cents').notNull().default(0),
    /** 模型积分 */
    credits: integer('credits').notNull().default(0),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.userId] })]
)

/**
 * 资金/积分流水。只增不改，每一分钱的来去都能追溯。
 * amountCents 与 creditsDelta 为有符号值：正数入账、负数出账。
 */
export const ledger = sqliteTable(
  'ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    /** topup / plan_purchase / proration_refund / renew / credit_exchange / model_usage / adjust */
    kind: text('kind').notNull(),
    amountCents: integer('amount_cents').notNull().default(0),
    creditsDelta: integer('credits_delta').notNull().default(0),
    /** 记账后的余额快照，便于对账时快速定位断点 */
    balanceAfter: integer('balance_after').notNull(),
    creditsAfter: integer('credits_after').notNull(),
    /** 关联单据类型与 id（订单、订阅、用量记录等） */
    refType: text('ref_type'),
    refId: text('ref_id'),
    note: text('note'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('idx_ledger_user').on(t.tenant, t.userId, t.createdAt)]
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
