import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    publicId: text('public_id'),
    avatarMediaId: text('avatar_media_id'),
    title: text('title').notNull(),
    isGroup: integer('is_group').notNull().default(0),
    detectedLang: text('detected_lang'),
    langOverride: text('lang_override'),
    autoReply: integer('auto_reply').notNull().default(0),
    pinned: integer('pinned').notNull().default(0),
    muted: integer('muted').notNull().default(0),
    customerNote: text('customer_note').notNull().default(''),
    lastMessagePreview: text('last_message_preview').notNull().default(''),
    /** 投放来源标识（广告 id 或追踪码），客户端归因后同步上来 */
    leadSourceCode: text('lead_source_code'),
    /** 归因方式：ad = 平台广告上下文，code = 预填文案追踪码 */
    leadSourceVia: text('lead_source_via'),
    lastMessageAt: integer('last_message_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] }), index('idx_conv_contact').on(t.tenant, t.contactId)]
)

/** 同一坐席账号在多台电脑之间共享已读位置；不同客服仍保留各自未读状态。 */
export const conversationReads = sqliteTable(
  'conversation_reads',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    readAt: integer('read_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.userId, t.conversationId] }),
    index('idx_conversation_reads_sync').on(t.tenant, t.userId, t.updatedAt, t.conversationId)
  ]
)

/**
 * 客户工作区账号目录。只存可漫游的账号壳，不存代理、指纹、平台凭证或登录会话。
 * deleted 是墓碑，防止离线旧电脑把已删除账号重新创建出来。
 */
export const workspaceAccounts = sqliteTable(
  'workspace_accounts',
  {
    tenant: text('tenant').notNull(),
    accountKey: text('account_key').notNull(),
    channel: text('channel').notNull(),
    accountId: text('account_id').notNull(),
    label: text('label'),
    defaultLang: text('default_lang'),
    deleted: integer('deleted').notNull().default(0),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.accountKey] })]
)

/** 多设备并发副作用的幂等占位（目前用于保证一条来信只触发一次 AI 自动回复）。 */
export const syncClaims = sqliteTable(
  'sync_claims',
  {
    tenant: text('tenant').notNull(),
    purpose: text('purpose').notNull(),
    claimKey: text('claim_key').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.purpose, t.claimKey] })]
)

/** 租户级后台配置（如工单分享域名） */
export const tenantSettings = sqliteTable('tenant_settings', {
  tenant: text('tenant').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.tenant, t.key] })])

/** 客户端代理商城目录。后台统一配置，桌面端只读取已上架条目。 */
export const proxyVendors = sqliteTable(
  'proxy_vendors',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** global / china */
    region: text('region').notNull(),
    summary: text('summary').notNull().default(''),
    /** 可以填写官网、购买页或渠道推广链接。 */
    purchaseUrl: text('purchase_url').notNull(),
    logoUrl: text('logo_url').notNull().default(''),
    badge: text('badge').notNull().default(''),
    buttonLabel: text('button_label').notNull().default('立即访问'),
    enabled: integer('enabled').notNull().default(1),
    recommended: integer('recommended').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.id] }),
    index('idx_proxy_vendors_list').on(t.tenant, t.enabled, t.region, t.sortOrder, t.createdAt)
  ]
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
    timestamp: integer('timestamp').notNull(),
    /** 服务端写入/补全译文的时间，用于桌面端增量回填。 */
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.externalId] }),
    index('idx_messages_conv').on(t.tenant, t.conversationId, t.timestamp),
    index('idx_messages_sync').on(t.tenant, t.updatedAt, t.externalId)
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

/**
 * 客户端用户（桌面端登录账号）。
 * ownerId 为空 = 老板（主账号）；有值 = 该老板的子账号（客服）。
 * 子账号没有自己的余额与订阅，配额与计费一律归属 owner。
 */
export const clientUsers = sqliteTable('client_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  verified: integer('verified').notNull().default(0),
  /** 归属的老板用户 id；空 = 自己就是老板 */
  ownerId: integer('owner_id'),
  /** 角色名（boss / agent / 老板自定义角色的 id） */
  role: text('role').notNull().default('boss'),
  /** JSON：直接分配的权限点（在角色之外补充） */
  permissions: text('permissions').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull()
})

/**
 * 用户可分享的邀请码。邀请码只负责首次注册归因；一旦写入 referrals，关系永久不变。
 * maxUses = 0 表示不限次数，expiresAt 为空表示永不过期。
 */
export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    tenant: text('tenant').notNull(),
    code: text('code').notNull(),
    inviterUserId: integer('inviter_user_id').notNull(),
    enabled: integer('enabled').notNull().default(1),
    maxUses: integer('max_uses').notNull().default(0),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.code] }),
    index('idx_invite_codes_owner').on(t.tenant, t.inviterUserId, t.createdAt)
  ]
)

/** 注册时建立的一次性、永久邀请关系；invitee 在同一租户只能有一个邀请人。 */
export const referrals = sqliteTable(
  'referrals',
  {
    tenant: text('tenant').notNull(),
    inviteeUserId: integer('invitee_user_id').notNull(),
    inviterUserId: integer('inviter_user_id').notNull(),
    inviteCode: text('invite_code').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.inviteeUserId] }),
    index('idx_referrals_inviter').on(t.tenant, t.inviterUserId, t.createdAt)
  ]
)

/** 租户级返佣比例；使用万分比避免浮点误差，1000 = 10%。 */
export const commissionSettings = sqliteTable('commission_settings', {
  tenant: text('tenant').primaryKey(),
  rateBps: integer('rate_bps').notNull().default(0),
  updatedAt: integer('updated_at').notNull()
})

/**
 * 返佣明细。sourceLedgerId 唯一对应一次原始充值/消费流水，保证支付回调重试也不会重复返佣。
 * 比例与基数保存快照，后台日后改比例不会篡改历史账目。
 */
export const commissionLedger = sqliteTable(
  'commission_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    inviterUserId: integer('inviter_user_id').notNull(),
    inviteeUserId: integer('invitee_user_id').notNull(),
    sourceLedgerId: integer('source_ledger_id').notNull(),
    eventType: text('event_type').notNull(),
    baseCents: integer('base_cents').notNull(),
    rateBps: integer('rate_bps').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    index('idx_commission_beneficiary').on(t.tenant, t.inviterUserId, t.createdAt),
    index('idx_commission_source_user').on(t.tenant, t.inviteeUserId, t.createdAt),
    uniqueIndex('idx_commission_source_ledger').on(t.tenant, t.sourceLedgerId)
  ]
)

/** 老板自定义角色：一组权限的命名打包，只能含老板自己拥有的权限 */
export const clientRoles = sqliteTable(
  'client_roles',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    ownerId: integer('owner_id').notNull(),
    name: text('name').notNull(),
    permissions: text('permissions').notNull().default('[]'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 客户端登录会话（token 同时作为同步凭证） */
export const clientSessions = sqliteTable('client_sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  /** 设备指纹（客户端 device-id.ts 派生）；老会话为空，不计入设备数 */
  deviceId: text('device_id'),
  /** 人类可读设备名（主机名/系统），仅用于展示 */
  deviceName: text('device_name'),
  /** 最近活跃时间（resolve 时节流刷新） */
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at')
})

/**
 * 平台账号的可迁移独立环境。snapshot 只保存 AES-256-GCM 密文，内容包含该账号的
 * 稳定指纹、代理绑定和平台登录态；activeDeviceId/leaseExpiresAt 防止同一环境被
 * 两台电脑同时连接到平台。
 */
export const accountEnvironments = sqliteTable(
  'account_environments',
  {
    tenant: text('tenant').notNull(),
    accountKey: text('account_key').notNull(),
    snapshot: text('snapshot').notNull(),
    revision: integer('revision').notNull().default(1),
    activeDeviceId: text('active_device_id'),
    leaseId: text('lease_id'),
    leaseExpiresAt: integer('lease_expires_at'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.accountKey] })]
)

/** 邮箱验证码 */
export const emailCodes = sqliteTable('email_codes', {
  email: text('email').primaryKey(),
  code: text('code').notNull(),
  expiresAt: integer('expires_at').notNull()
})

/**
 * 会话意向标签（M5 实时自动打标签）。
 * 新入站消息触发意向重算后落库；会话列表据此显示标签，无需每次现算。
 * lastInboundAt = 上次分析时最新入站消息时间，用于判断是否需要重打。
 */
export const conversationIntent = sqliteTable(
  'conversation_intent',
  {
    tenant: text('tenant').notNull(),
    conversationId: text('conversation_id').notNull(),
    level: text('level').notNull().default('unknown'),
    summary: text('summary').notNull().default(''),
    signals: text('signals').notNull().default('[]'),
    suggestedAction: text('suggested_action').notNull().default(''),
    analyzedAt: integer('analyzed_at').notNull(),
    lastInboundAt: integer('last_inbound_at').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.tenant, t.conversationId] })]
)

/**
 * 客户端配置云同步（跨设备漫游）。
 * 每个客户端用户一条；blob 是「非敏感偏好白名单」的 JSON。
 * 红线：绝不存平台账号凭证/会话/代理与登录令牌 —— 那些按设计留在各设备本地。
 */
export const clientConfigs = sqliteTable(
  'client_configs',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    blob: text('blob').notNull().default('{}'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.userId] })]
)

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
 * Meta 授权后的业务资产。accessToken 是 AES-256-GCM 密文，桌面端永不读取。
 * ownerId 让同一租户下不同老板/团队不能互相操作对方的 Page 或 IG 账号。
 */
export const metaAccounts = sqliteTable('meta_accounts', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  channel: text('channel').notNull(),
  accountId: text('account_id').notNull(),
  assetId: text('asset_id').notNull(),
  pageId: text('page_id').notNull(),
  displayName: text('display_name').notNull(),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  accessToken: text('access_token').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.channel, t.accountId] }),
  index('idx_meta_accounts_asset').on(t.channel, t.assetId),
  index('idx_meta_accounts_page').on(t.channel, t.pageId)
])

/** Meta OAuth 临时状态；授权完成或 15 分钟过期后删除。data 同样是密文。 */
export const metaOauthStates = sqliteTable('meta_oauth_states', {
  state: text('state').primaryKey(),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  channel: text('channel').notNull(),
  accountId: text('account_id').notNull(),
  status: text('status').notNull().default('authorizing'),
  error: text('error'),
  data: text('data').notNull().default(''),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_meta_oauth_account').on(t.tenant, t.ownerId, t.channel, t.accountId)])

/** Meta Webhook 原始事件队列；桌面适配器拉取后删除，离线期间仍可保留消息。 */
export const metaEvents = sqliteTable('meta_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  channel: text('channel').notNull(),
  accountId: text('account_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_meta_events').on(t.tenant, t.ownerId, t.channel, t.accountId)])

/** TikTok Business Messaging 授权账号；两种令牌都只以 AES-256-GCM 密文落服务器。 */
export const tiktokAccounts = sqliteTable('tiktok_accounts', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  businessId: text('business_id').notNull(),
  displayName: text('display_name').notNull(),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  accessTokenExpiresAt: integer('access_token_expires_at').notNull(),
  refreshTokenExpiresAt: integer('refresh_token_expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.accountId] }),
  index('idx_tiktok_accounts_business').on(t.businessId)
])

/** TikTok OAuth 一次性 state，15 分钟过期。 */
export const tiktokOauthStates = sqliteTable('tiktok_oauth_states', {
  state: text('state').primaryKey(),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  status: text('status').notNull().default('authorizing'),
  error: text('error'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_tiktok_oauth_account').on(t.tenant, t.ownerId, t.accountId)])

/** TikTok Webhook 事件队列；客户端离线时先留在主库，成功拉取后删除。 */
export const tiktokEvents = sqliteTable('tiktok_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_tiktok_events').on(t.tenant, t.ownerId, t.accountId)])

/** X OAuth 2.0 授权账号；令牌只以 AES-256-GCM 密文留在主库。 */
export const xAccounts = sqliteTable('x_accounts', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  userId: text('user_id').notNull(),
  displayName: text('display_name').notNull(),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  accessTokenExpiresAt: integer('access_token_expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.accountId] }),
  index('idx_x_accounts_user').on(t.userId)
])

/** X PKCE OAuth 一次性状态。 */
export const xOauthStates = sqliteTable('x_oauth_states', {
  state: text('state').primaryKey(),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  status: text('status').notNull().default('authorizing'),
  error: text('error'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_x_oauth_account').on(t.tenant, t.ownerId, t.accountId)])

/** Snapchat 品牌 Public Profile 授权账号。 */
export const snapchatAccounts = sqliteTable('snapchat_accounts', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  profileId: text('profile_id').notNull(),
  displayName: text('display_name').notNull(),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  accessTokenExpiresAt: integer('access_token_expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.accountId] }),
  index('idx_snapchat_accounts_profile').on(t.profileId)
])

/** Snapchat OAuth 一次性状态。 */
export const snapchatOauthStates = sqliteTable('snapchat_oauth_states', {
  state: text('state').primaryKey(),
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  status: text('status').notNull().default('authorizing'),
  error: text('error'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [index('idx_snapchat_oauth_account').on(t.tenant, t.ownerId, t.accountId)])

/** Snapchat 官方接口不提供会话列表，已指定的创作者会话需由服务器持久化。 */
export const snapchatConversations = sqliteTable('snapchat_conversations', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  conversationToken: text('conversation_token').notNull(),
  creatorProfileId: text('creator_profile_id').notNull(),
  creatorName: text('creator_name').notNull(),
  creatorHandle: text('creator_handle'),
  avatarUrl: text('avatar_url'),
  updatedAt: integer('updated_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.accountId, t.conversationId] }),
  index('idx_snapchat_conversations_creator').on(t.tenant, t.ownerId, t.accountId, t.creatorProfileId)
])

/** 记录本系统发出的 Snapchat 消息，供轮询历史时可靠判定方向。 */
export const snapchatSentMessages = sqliteTable('snapchat_sent_messages', {
  tenant: text('tenant').notNull(),
  ownerId: integer('owner_id').notNull().default(0),
  accountId: text('account_id').notNull(),
  messageId: text('message_id').notNull(),
  createdAt: integer('created_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.tenant, t.ownerId, t.accountId, t.messageId] }),
  index('idx_snapchat_sent_created').on(t.createdAt)
])

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
    /** JSON 字符串：accountId → 工单创建时的账号资料（平台、手机号、头像媒体） */
    accountProfiles: text('account_profiles').notNull().default('{}'),
    /** 工单总目标数 */
    totalTarget: integer('total_target').notNull().default(0),
    /** 公开分享页访问密码开关；密码本身只保存哈希 */
    accessPasswordEnabled: integer('access_password_enabled').notNull().default(0),
    accessPasswordHash: text('access_password_hash'),
    /** 是否允许分享页查看粉丝详情与进粉趋势；旧工单默认保持允许。 */
    allowFanData: integer('allow_fan_data').notNull().default(1),
    /** JSON 字符串：accountId → 该账号目标数 */
    accountTargets: text('account_targets').notNull().default('{}'),
    accountTargetsManual: integer('account_targets_manual').notNull().default(0),
    /** 每日统计重置时间，按北京时间解释，格式 HH:mm */
    resetTime: text('reset_time').notNull().default('00:00'),
    startAt: integer('start_at').notNull(),
    /** 空 = 持续进行 */
    endAt: integer('end_at'),
    /** JSON 字符串：选中的重粉库 id 数组 */
    dedupLibraryIds: text('dedup_library_ids').notNull().default('[]'),
    /** 该时间之前出现过即算重复；空 = 不启用时间规则 */
    dedupBeforeAt: integer('dedup_before_at'),
    /** JSON：时间规则只看这些账号的历史；空数组 = 全部账号 */
    dedupAccountIds: text('dedup_account_ids').notNull().default('[]'),
    /** JSON：只统计这些投放来源码；空数组 = 全部来源 */
    sourceCodes: text('source_codes').notNull().default('[]'),
    /** 公开看板是否允许中国大陆 IP 访问（默认不允许） */
    allowCnIp: integer('allow_cn_ip').notNull().default(0),
    /** 公开看板是否允许香港 IP 访问（默认不允许） */
    allowHkIp: integer('allow_hk_ip').notNull().default(0),
    /** 看板时区偏移（分钟），固定 UTC+8（北京时间） */
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
    /** whatsapp / telegram / telegram_bot / line / kakaotalk / facebook / instagram / tiktok / x / snapchat */
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
    /** 可同时登录的设备数上限；0 = 不限 */
    maxDevices: integer('max_devices').notNull().default(0),
    /** 套餐描述（Markdown 源文本，客户端渲染） */
    description: text('description').notNull().default(''),
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

/** 支付通道配置。config 存各通道自己的密钥等，按 type 解释 */
export const paymentChannels = sqliteTable(
  'payment_channels',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    /** yipay / paypal / usdt / mock */
    type: text('type').notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull().default(1),
    /** JSON：网关地址、商户号、密钥、收款地址等 */
    config: text('config').notNull().default('{}'),
    /** 手续费率，0.024 = 2.4% */
    feeRate: text('fee_rate').notNull().default('0'),
    feeFixedCents: integer('fee_fixed_cents').notNull().default(0),
    /** merchant = 商户承担；customer = 加在用户应付金额上 */
    feePaidBy: text('fee_paid_by').notNull().default('merchant'),
    /** 该通道收款币种；空 = 用美元 */
    currency: text('currency').notNull().default('USD'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 汇率表：1 USD = rate 个目标币种 */
export const exchangeRates = sqliteTable(
  'exchange_rates',
  {
    tenant: text('tenant').notNull(),
    currency: text('currency').notNull(),
    /** 存字符串避免浮点在往返存取中失真 */
    rate: text('rate').notNull(),
    decimals: integer('decimals').notNull().default(2),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.currency] })]
)

/**
 * 支付订单。
 * amountCents 是「用户想买到的价值」，payableCents 是「实际要付多少」，
 * 两者之差就是客户承担的手续费。结算时按 amountCents 入账。
 */
export const orders = sqliteTable(
  'orders',
  {
    tenant: text('tenant').notNull(),
    /** 商户订单号，同时是给通道的 out_trade_no */
    id: text('id').notNull(),
    userId: integer('user_id').notNull(),
    /** topup = 充值余额；plan = 购买套餐 */
    kind: text('kind').notNull(),
    planId: text('plan_id'),
    /** 商品价值（美分 USD），结算时按这个入账 */
    amountCents: integer('amount_cents').notNull(),
    feeCents: integer('fee_cents').notNull().default(0),
    /** 用户应付（美分 USD） */
    payableCents: integer('payable_cents').notNull(),
    /** 实际收款币种与锁定汇率 —— 汇率会变，必须下单时存下来 */
    currency: text('currency').notNull().default('USD'),
    lockedRate: text('locked_rate').notNull().default('1'),
    /** 收款金额，目标币种最小单位 */
    payableLocal: integer('payable_local').notNull().default(0),
    channelId: text('channel_id'),
    channelType: text('channel_type'),
    /** pending / paid / failed / expired */
    status: text('status').notNull().default('pending'),
    /** 通道侧流水号，回调时写入 */
    tradeNo: text('trade_no'),
    paidAt: integer('paid_at'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.id] }),
    index('idx_orders_user').on(t.tenant, t.userId, t.createdAt)
  ]
)

// ══════════ AI 供应商与模型积分 ══════════

/** AI 供应商配置。apiKey 明文存库，接口返回时必须打码 */
export const aiProviders = sqliteTable(
  'ai_providers',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    /** openai / anthropic / openrouter / openai_compatible */
    type: text('type').notNull(),
    name: text('name').notNull(),
    /** 自定义 baseUrl，兼容各种中转；留空用该协议默认地址 */
    baseUrl: text('base_url').notNull().default(''),
    apiKey: text('api_key').notNull().default(''),
    enabled: integer('enabled').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 某供应商下的可用模型与积分单价 */
export const aiModels = sqliteTable(
  'ai_models',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    providerId: text('provider_id').notNull(),
    /** 调用时传给供应商的模型名 */
    modelName: text('model_name').notNull(),
    label: text('label').notNull().default(''),
    /** JSON 数组：asr / translate / autoreply */
    purposes: text('purposes').notNull().default('[]'),
    /** 每百万输入/输出 token 的积分数（整数） */
    creditsPerMillionInput: integer('credits_per_million_input').notNull().default(0),
    creditsPerMillionOutput: integer('credits_per_million_output').notNull().default(0),
    /** 语音识别按秒计费 */
    creditsPerAudioSecond: integer('credits_per_audio_second').notNull().default(0),
    minCredits: integer('min_credits').notNull().default(0),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.id] }),
    index('idx_ai_models_provider').on(t.tenant, t.providerId)
  ]
)

/** 模型调用用量流水；对账与分析用量分布都靠它 */
export const modelUsage = sqliteTable(
  'model_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    modelId: text('model_id').notNull(),
    /** asr / translate / autoreply */
    purpose: text('purpose').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    audioSeconds: integer('audio_seconds').notNull().default(0),
    credits: integer('credits').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('idx_usage_user').on(t.tenant, t.userId, t.createdAt)]
)

/** 租户级计费参数 */
export const billingSettings = sqliteTable('billing_settings', {
  tenant: text('tenant').primaryKey(),
  /** 1 美元可兑换多少积分 */
  creditsPerUsd: integer('credits_per_usd').notNull().default(1000),
  /** 积分不足时是否自动从余额兑换补足 */
  autoTopUpCredits: integer('auto_top_up_credits').notNull().default(1),
  updatedAt: integer('updated_at').notNull()
})

// ══════════ 运营公告与通知 ══════════

/**
 * 公告（管理员 → 定向人群）。受众在**拉取时**按用户实时求值，
 * 不做静态名单 —— 用户今天买了套餐，明天就该看到对应套餐的公告。
 */
export const announcements = sqliteTable(
  'announcements',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** all / plan / new_users / expiring */
    audience: text('audience').notNull().default('all'),
    /** plan → planId；new_users/expiring → 天数 */
    audienceParam: text('audience_param').notNull().default(''),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
)

/** 公告已读标记 */
export const announcementReads = sqliteTable(
  'announcement_reads',
  {
    tenant: text('tenant').notNull(),
    announcementId: text('announcement_id').notNull(),
    userId: integer('user_id').notNull(),
    readAt: integer('read_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.announcementId, t.userId] })]
)

/** 个人通知（系统生成，如到期提醒）；readAt 为空 = 未读 */
export const userNotices = sqliteTable(
  'user_notices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    /** expiry / system */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('idx_notices_user').on(t.tenant, t.userId, t.readAt)]
)

/** 到期提醒配置（租户级） */
export const reminderSettings = sqliteTable('reminder_settings', {
  tenant: text('tenant').primaryKey(),
  enabled: integer('enabled').notNull().default(0),
  /** 逗号分隔的提前天数，如 "7,3,1" */
  daysBefore: text('days_before').notNull().default('7,3,1'),
  emailEnabled: integer('email_enabled').notNull().default(0),
  emailSubject: text('email_subject').notNull().default(''),
  emailBody: text('email_body').notNull().default(''),
  updatedAt: integer('updated_at').notNull()
})

/** 到期提醒去重：每档提前天数对每个到期周期只发一次 */
export const remindersSent = sqliteTable(
  'reminders_sent',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    threshold: integer('threshold').notNull(),
    expiresAt: integer('expires_at').notNull(),
    sentAt: integer('sent_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.userId, t.threshold, t.expiresAt] })]
)

// ══════════ 支持工单（软件使用问题，区别于引流 campaign） ══════════

export const supportTickets = sqliteTable(
  'support_tickets',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    userId: integer('user_id').notNull(),
    title: text('title').notNull(),
    /** open / replied / closed */
    status: text('status').notNull().default('open'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.id] }),
    index('idx_tickets_user').on(t.tenant, t.userId, t.updatedAt)
  ]
)

export const supportMessages = sqliteTable(
  'support_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    ticketId: text('ticket_id').notNull(),
    /** user / admin */
    sender: text('sender').notNull(),
    /** 管理员回复时记录操作者用户名，便于追责 */
    senderName: text('sender_name'),
    body: text('body').notNull().default(''),
    /** 附图（media 表的 mediaId） */
    mediaId: text('media_id'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('idx_ticket_msgs').on(t.tenant, t.ticketId, t.createdAt)]
)

/** 客户端上报的运行日志（M19）。游客日志 userId 为空，靠 deviceId 归拢。 */
export const clientLogs = sqliteTable(
  'client_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenant: text('tenant').notNull(),
    /** 客户端登录用户；游客为空 */
    userId: integer('user_id'),
    /** 硬件派生的设备指纹（哈希，不含隐私原文） */
    deviceId: text('device_id').notNull(),
    /** debug / info / warn / error */
    level: text('level').notNull(),
    /** 日志作用域（如 whatsapp:main） */
    scope: text('scope').notNull().default(''),
    message: text('message').notNull(),
    /** 附加元数据（JSON 字符串） */
    meta: text('meta'),
    appVersion: text('app_version').notNull().default(''),
    osType: text('os_type').notNull().default(''),
    osVersion: text('os_version').notNull().default(''),
    /** 客户端本地时间戳 */
    at: integer('at').notNull(),
    /** 服务端接收时间 */
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    index('idx_client_logs').on(t.tenant, t.createdAt),
    index('idx_client_logs_device').on(t.tenant, t.deviceId, t.createdAt)
  ]
)

/** 管理后台控制的按用户日志级别（未设置默认 warn） */
export const clientLogLevels = sqliteTable(
  'client_log_levels',
  {
    tenant: text('tenant').notNull(),
    userId: integer('user_id').notNull(),
    level: text('level').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.userId] })]
)

/** 已保存的推广入口链接（M-entry）：一个来源一条，方便运营区分投放渠道 */
export const entryLinks = sqliteTable(
  'entry_links',
  {
    tenant: text('tenant').notNull(),
    id: text('id').notNull(),
    /** 备注名，如「FB 广告组A」 */
    name: text('name').notNull(),
    channel: text('channel').notNull(),
    accountId: text('account_id').notNull(),
    /** 账号句柄（手机号/用户名/LINE ID） */
    handle: text('handle').notNull(),
    /** 追踪码（进线归因用） */
    code: text('code').notNull(),
    greeting: text('greeting').notNull().default(''),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tenant, t.id] })]
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
