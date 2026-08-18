/** 管理后台 API 客户端（前后端分离，调用 server 的 REST 接口） */

export interface Conversation {
  id: string
  channel: string
  accountId: string
  contactId?: string
  title: string
  isGroup: boolean
  lastMessageAt: number
  /** 意向标签（实时自动打标签结果）；未打标签则不带 */
  intentLevel?: 'high' | 'medium' | 'low' | 'unknown'
}

export interface Message {
  externalId: string
  conversationId: string
  channel: string
  accountId: string
  direction: 'in' | 'out'
  authorName?: string
  bodyType: 'text' | 'media' | 'unsupported'
  text?: string
  mediaType?: string
  caption?: string
  translationText?: string
  timestamp: number
}

export interface IntentAnalysis {
  intentLevel: 'high' | 'medium' | 'low' | 'unknown'
  summary: string
  signals: string[]
  suggestedAction: string
}

/**
 * 工单与统计类型，与 server/src/campaign-* 保持一致。
 * 统计结构里刻意没有任何客户标识 —— 看板可公开分享，只允许聚合数字。
 */
export interface Campaign {
  id: string
  name: string
  accountIds: string[]
  accountLabels: Record<string, string>
  startAt: number
  endAt?: number
  dedupLibraryIds: string[]
  dedupBeforeAt?: number
  dedupAccountIds: string[]
  tzOffsetMinutes: number
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export interface Bucket {
  total: number
  duplicate: number
  fresh: number
}

export interface CampaignStats {
  total: number
  duplicate: number
  fresh: number
  effective: number
  duplicateBy: { library: number; timeRange: number }
  byAccount: Array<{ accountId: string; channel: string; label?: string } & Bucket>
  byDay: Array<{ date: string } & Bucket>
  /** 按投放来源拆分；code 是广告 id 或追踪码，未归因的 code 为空 */
  bySource: Array<{ code: string; via?: 'ad' | 'code' } & Bucket>
  response: { replied: number; replyRate: number; medianFirstReplySec: number | null }
  computedAt: number
}

export interface CampaignLink {
  token: string
  campaignId: string
  label?: string
  expiresAt?: number
  revoked: boolean
  createdAt: number
  active: boolean
}

export interface FanLibrary {
  id: string
  name: string
  channel: string
  source: string
  entryCount: number
  createdAt: number
}

/** 计费相关类型，与 server/src/billing 保持一致 */
export interface Plan {
  id: string
  name: string
  priceCents: number
  periodUnit: 'month' | 'quarter' | 'half_year' | 'year' | 'day'
  periodCount: number
  maxAccounts: number
  /** 可同时登录的设备数上限；0 = 不限 */
  maxDevices?: number
  enabled: boolean
  sortOrder: number
  createdAt: number
  description?: string
}

export interface PayChannel {
  id: string
  type: 'yipay' | 'paypal' | 'usdt' | 'mock'
  name: string
  enabled: boolean
  config: Record<string, string>
  feeRate: number
  feeFixedCents: number
  feePaidBy: 'merchant' | 'customer'
  currency: string
  sortOrder: number
  createdAt: number
}

export interface ExRate {
  currency: string
  rate: number
  decimals: number
}

export interface AiProvider {
  id: string
  type: 'openai' | 'anthropic' | 'openrouter' | 'openai_compatible'
  name: string
  baseUrl: string
  apiKeyMasked: string
  enabled: boolean
  sortOrder: number
  createdAt: number
}

export interface AiModelRow {
  id: string
  providerId: string
  modelName: string
  label: string
  purposes: string[]
  creditsPerMillionInput: number
  creditsPerMillionOutput: number
  creditsPerAudioSecond: number
  minCredits: number
  enabled: boolean
  createdAt: number
}

export interface SupportTicket {
  id: string
  userId: number
  title: string
  status: 'open' | 'replied' | 'closed'
  createdAt: number
  updatedAt: number
}

export interface SupportMsg {
  id: number
  sender: 'user' | 'admin'
  senderName?: string
  body: string
  mediaId?: string
  createdAt: number
}

export interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: 'all' | 'plan' | 'new_users' | 'expiring'
  audienceParam: string
  enabled: boolean
  createdAt: number
}

export interface ReminderSettingsRow {
  enabled: boolean
  daysBefore: number[]
  emailEnabled: boolean
  emailSubject: string
  emailBody: string
}

export interface Me {
  username: string
  role: string
  permissions: string[]
}

export interface AdminUser {
  id: number
  username: string
  role: string
  permissions: string[]
  enabled: boolean
}

export interface PermMeta {
  permissions: string[]
  roles: string[]
  rolePresets: Record<string, string[]>
}

/** 账号密码登录，成功返回访问令牌与用户信息 */
export async function login(
  base: string,
  username: string,
  password: string
): Promise<{ token: string; user: Me }> {
  const res = await fetch(base.replace(/\/$/, '') + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<{ token: string; user: Me }>
}

export interface ClientLogRow {
  id: number
  userId: number | null
  email?: string
  deviceId: string
  level: string
  scope: string
  message: string
  meta: string | null
  appVersion: string
  osType: string
  osVersion: string
  at: number
  createdAt: number
}

export interface LogDevice {
  deviceId: string
  userId: number | null
  email?: string
  appVersion: string
  osType: string
  osVersion: string
  lastAt: number
  total: number
  errors: number
}

export interface AdminOrder {
  id: string
  userId: number
  email?: string
  kind: 'topup' | 'plan'
  planId?: string
  amountCents: number
  payableCents: number
  payableLocal: number
  currency: string
  channelId: string
  status: string
  tradeNo?: string
  createdAt: number
  paidAt?: number
}

export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly token: string
  ) {}

  private async req<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base.replace(/\/$/, '') + path, {
      ...opts,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...opts.headers
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  listConversations(limit = 200): Promise<{ conversations: Conversation[] }> {
    return this.req(`/api/conversations?limit=${limit}`)
  }

  listMessages(id: string): Promise<{ messages: Message[] }> {
    return this.req(`/api/conversations/${encodeURIComponent(id)}/messages`)
  }

  analyzeConversation(id: string): Promise<{ analysis: IntentAnalysis }> {
    return this.req(`/api/analyze/conversation/${encodeURIComponent(id)}`, { method: 'POST' })
  }

  /** 已落库的意向分析（自动打标签/深度分析结果），打开会话即读，无需 key */
  getIntent(id: string): Promise<{ intent: (IntentAnalysis & { analyzedAt: number }) | null }> {
    return this.req(`/api/conversations/${encodeURIComponent(id)}/intent`)
  }

  analyzeContact(contactId: string): Promise<{ analysis: IntentAnalysis }> {
    return this.req(`/api/analyze/contact/${encodeURIComponent(contactId)}`, { method: 'POST' })
  }

  me(): Promise<Me> {
    return this.req('/api/me')
  }

  logout(): Promise<{ ok: boolean }> {
    return this.req('/api/logout', { method: 'POST' })
  }

  // ── 引流工单 / 重粉库（需 campaigns:manage）──
  // 工单本身由老板在客户端创建，后台这边只读统计并管分享链接，
  // 所以不提供创建接口 —— 避免两边各建一份、口径对不上。
  listCampaigns(): Promise<{ campaigns: Campaign[] }> {
    return this.req('/api/campaigns')
  }

  campaignStats(id: string): Promise<{ campaign: Campaign; stats: CampaignStats }> {
    return this.req(`/api/campaigns/${encodeURIComponent(id)}/stats`)
  }

  listLinks(id: string): Promise<{ links: CampaignLink[]; publicBase: string }> {
    return this.req(`/api/campaigns/${encodeURIComponent(id)}/links`)
  }

  createLink(
    id: string,
    body: { label?: string; expiresAt?: number }
  ): Promise<{ link: CampaignLink; url: string }> {
    return this.req(`/api/campaigns/${encodeURIComponent(id)}/links`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  revokeLink(token: string): Promise<{ ok: boolean }> {
    return this.req(`/api/campaigns/links/${encodeURIComponent(token)}/revoke`, { method: 'POST' })
  }

  listLibraries(): Promise<{ libraries: FanLibrary[] }> {
    return this.req('/api/fan-libraries')
  }

  deleteLibrary(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/fan-libraries/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // ── 计费管理（需 billing:manage）──
  listPlans(): Promise<{ plans: Plan[] }> {
    return this.req('/api/admin/plans')
  }

  createPlan(body: Partial<Plan>): Promise<{ plan: Plan }> {
    return this.req('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) })
  }

  updatePlan(id: string, body: Partial<Plan>): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/plans/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  listChannels(): Promise<{ channels: PayChannel[] }> {
    return this.req('/api/admin/channels')
  }

  createChannel(body: Partial<PayChannel>): Promise<{ channel: PayChannel }> {
    return this.req('/api/admin/channels', { method: 'POST', body: JSON.stringify(body) })
  }

  updateChannel(id: string, body: Partial<PayChannel>): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  deleteChannel(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  listRates(): Promise<{ rates: ExRate[] }> {
    return this.req('/api/admin/rates')
  }

  setRate(currency: string, rate: number, decimals: number): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/rates/${encodeURIComponent(currency)}`, {
      method: 'PUT',
      body: JSON.stringify({ rate, decimals })
    })
  }

  deleteRate(currency: string): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/rates/${encodeURIComponent(currency)}`, { method: 'DELETE' })
  }

  listAiProviders(): Promise<{ providers: AiProvider[] }> {
    return this.req('/api/admin/ai/providers')
  }

  createAiProvider(body: Partial<AiProvider> & { apiKey?: string }): Promise<{ provider: AiProvider }> {
    return this.req('/api/admin/ai/providers', { method: 'POST', body: JSON.stringify(body) })
  }

  updateAiProvider(
    id: string,
    body: Partial<AiProvider> & { apiKey?: string }
  ): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/ai/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  deleteAiProvider(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/ai/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  listAiModels(): Promise<{ models: AiModelRow[] }> {
    return this.req('/api/admin/ai/models')
  }

  createAiModel(body: Partial<AiModelRow>): Promise<{ model: AiModelRow }> {
    return this.req('/api/admin/ai/models', { method: 'POST', body: JSON.stringify(body) })
  }

  updateAiModel(id: string, body: Partial<AiModelRow>): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/ai/models/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  deleteAiModel(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/ai/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  billingSettings(): Promise<{ settings: { creditsPerUsd: number; autoTopUpCredits: boolean } }> {
    return this.req('/api/admin/billing-settings')
  }

  updateBillingSettings(body: {
    creditsPerUsd?: number
    autoTopUpCredits?: boolean
  }): Promise<{ settings: { creditsPerUsd: number; autoTopUpCredits: boolean } }> {
    return this.req('/api/admin/billing-settings', { method: 'PUT', body: JSON.stringify(body) })
  }

  usageSummary(): Promise<{
    summary: Array<{ modelId: string; purpose: string; calls: number; credits: number }>
  }> {
    return this.req('/api/admin/usage-summary')
  }

  // ── 运营公告与到期提醒（需 announcements:manage）──
  listAnnouncements(): Promise<{ announcements: AnnouncementRow[] }> {
    return this.req('/api/admin/announcements')
  }

  createAnnouncement(body: Partial<AnnouncementRow>): Promise<{ announcement: AnnouncementRow }> {
    return this.req('/api/admin/announcements', { method: 'POST', body: JSON.stringify(body) })
  }

  updateAnnouncement(id: string, body: Partial<AnnouncementRow>): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/announcements/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  deleteAnnouncement(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  reminderSettings(): Promise<{ settings: ReminderSettingsRow; vars: string[] }> {
    return this.req('/api/admin/reminder-settings')
  }

  updateReminderSettings(body: Partial<ReminderSettingsRow>): Promise<{ settings: ReminderSettingsRow }> {
    return this.req('/api/admin/reminder-settings', { method: 'PUT', body: JSON.stringify(body) })
  }

  // ── 订单与余额（需 billing:manage）──
  listAdminOrders(status?: string): Promise<{ orders: AdminOrder[] }> {
    return this.req(`/api/admin/orders${status ? `?status=${status}` : ''}`)
  }

  markOrderPaid(id: string): Promise<{ ok: boolean; alreadyPaid: boolean }> {
    return this.req(`/api/admin/orders/${encodeURIComponent(id)}/mark-paid`, { method: 'POST' })
  }

  adjustBalance(body: {
    email: string
    deltaCents: number
    note?: string
  }): Promise<{ ok: boolean; balance: { balanceCents: number; credits: number } }> {
    return this.req('/api/admin/balance-adjust', { method: 'POST', body: JSON.stringify(body) })
  }

  // ── 客户端日志（需 support:manage）──
  listClientLogs(filter: {
    level?: string
    userId?: number
    deviceId?: string
    q?: string
    limit?: number
    offset?: number
  }): Promise<{ logs: ClientLogRow[]; total: number }> {
    const qs = new URLSearchParams()
    if (filter.level) qs.set('level', filter.level)
    if (filter.userId !== undefined) qs.set('userId', String(filter.userId))
    if (filter.deviceId) qs.set('deviceId', filter.deviceId)
    if (filter.q) qs.set('q', filter.q)
    if (filter.limit !== undefined) qs.set('limit', String(filter.limit))
    if (filter.offset !== undefined) qs.set('offset', String(filter.offset))
    const suffix = qs.toString()
    return this.req(`/api/admin/logs${suffix ? `?${suffix}` : ''}`)
  }

  listLogDevices(): Promise<{
    devices: LogDevice[]
    levels: Array<{ userId: number; level: string }>
  }> {
    return this.req('/api/admin/logs/devices')
  }

  setLogLevel(userId: number, level: string): Promise<{ ok: boolean }> {
    return this.req('/api/admin/logs/level', {
      method: 'POST',
      body: JSON.stringify({ userId, level })
    })
  }

  // ── 支持工单（需 support:manage）──
  listSupportTickets(): Promise<{ tickets: SupportTicket[] }> {
    return this.req('/api/admin/support/tickets')
  }

  supportTicket(id: string): Promise<{ ticket: SupportTicket; messages: SupportMsg[] }> {
    return this.req(`/api/support/tickets/${encodeURIComponent(id)}`)
  }

  replySupportTicket(
    id: string,
    body: string
  ): Promise<{ ticket: SupportTicket; messages: SupportMsg[] }> {
    return this.req(`/api/support/tickets/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body })
    })
  }

  closeSupportTicket(id: string): Promise<{ ok: boolean }> {
    return this.req(`/api/support/tickets/${encodeURIComponent(id)}/close`, { method: 'POST' })
  }

  /** 拉取受保护媒体为对象 URL（img 标签不能带 Authorization 头） */
  async mediaObjectUrl(mediaId: string): Promise<string> {
    const res = await fetch(
      `${this.base.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
      { headers: { authorization: `Bearer ${this.token}` } }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return URL.createObjectURL(await res.blob())
  }

  // ── 用户管理（需 users:manage）──
  permMeta(): Promise<PermMeta> {
    return this.req('/api/meta/permissions')
  }

  listUsers(): Promise<{ users: AdminUser[] }> {
    return this.req('/api/users')
  }

  createUser(body: {
    username: string
    password: string
    role: string
    permissions: string[]
  }): Promise<{ user: AdminUser }> {
    return this.req('/api/users', { method: 'POST', body: JSON.stringify(body) })
  }

  updateUser(
    id: number,
    body: { role?: string; permissions?: string[]; enabled?: boolean; password?: string }
  ): Promise<{ ok: boolean }> {
    return this.req(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  }

  deleteUser(id: number): Promise<{ ok: boolean }> {
    return this.req(`/api/users/${id}`, { method: 'DELETE' })
  }
}
