import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import type { ServerConfig } from './config.ts'
import type { Db } from './db.ts'
import {
  snapchatAccounts,
  snapchatConversations,
  snapchatOauthStates,
  snapchatSentMessages
} from './schema.ts'

const API_BASE = 'https://businessapi.snapchat.com'
const AUTHORIZE_URL = 'https://accounts.snapchat.com/login/oauth2/authorize'
const TOKEN_URL = 'https://accounts.snapchat.com/login/oauth2/access_token'
const OAUTH_TTL_MS = 15 * 60 * 1000
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const SENT_TTL_MS = 90 * 24 * 60 * 60 * 1000
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/
const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/

export interface SnapchatAccountView {
  channel: 'snapchat'
  accountId: string
  profileId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

export interface SnapchatOauthResult {
  status: 'connected' | 'error'
  message: string
}

export interface SnapchatHistoryConversation {
  externalChatId: string
  title: string
  publicId?: string
  contactId: string
  avatarUrl?: string
  updatedTime: number
  messages: Array<Record<string, unknown>>
}

interface SnapProfile {
  id: string
  name?: string
  username?: string
  avatarUrl?: string
}

interface TokenData {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

export class SnapchatServiceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Snapchat 官方 Public Profile Messaging（品牌公共主页 ↔ 创作者）接入。 */
export class SnapchatService {
  private readonly cipher: TokenCipher
  private readonly db: Db
  private readonly config: ServerConfig
  private readonly fetchImpl: typeof fetch

  constructor(
    db: Db,
    config: ServerConfig,
    fetchImpl: typeof fetch = fetch
  ) {
    this.db = db
    this.config = config
    this.fetchImpl = fetchImpl
    this.cipher = new TokenCipher(
      config.snapchatTokenEncryptionKey || config.metaTokenEncryptionKey || config.snapchatClientSecret
    )
  }

  available(): boolean {
    return Boolean(
      this.config.snapchatClientId && this.config.snapchatClientSecret && this.cipher.available
    )
  }

  oauthRedirectUri(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/oauth/snapchat/callback`
  }

  beginOauth(tenant: string, ownerId: number, accountId: string): { url: string; expiresAt: number } {
    this.assertAvailable()
    assertAccountId(accountId)
    this.prune()
    this.db.delete(snapchatOauthStates).where(and(
      eq(snapchatOauthStates.tenant, tenant),
      eq(snapchatOauthStates.ownerId, ownerId),
      eq(snapchatOauthStates.accountId, accountId)
    )).run()
    const state = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + OAUTH_TTL_MS
    this.db.insert(snapchatOauthStates).values({
      state, tenant, ownerId, accountId, status: 'authorizing', expiresAt, createdAt: now
    }).run()
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.snapchatClientId!,
      redirect_uri: this.oauthRedirectUri(),
      scope: 'snapchat-profile-api',
      state
    })
    return { url: `${AUTHORIZE_URL}?${params}`, expiresAt }
  }

  async completeOauth(state: string, code?: string, oauthError?: string): Promise<SnapchatOauthResult> {
    const pending = this.requireOauthState(state)
    if (oauthError) return this.failOauth(state, oauthError)
    if (!code) return this.failOauth(state, '授权回调缺少 code。')
    try {
      const token = await this.tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: this.oauthRedirectUri()
      })
      if (!token.access_token || !token.refresh_token) {
        throw new SnapchatServiceError('Snapchat 没有返回完整的 access/refresh token。', 502)
      }
      const profile = await this.myProfile(token.access_token)
      if (!profile.id) throw new SnapchatServiceError('当前账号没有可接入的 Snapchat Public Profile。', 403)
      const now = Date.now()
      const values = {
        tenant: pending.tenant,
        ownerId: pending.ownerId,
        accountId: pending.accountId,
        profileId: profile.id,
        displayName: profile.name || profile.username || 'Snapchat Public Profile',
        handle: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        accessToken: this.cipher.encrypt(token.access_token),
        refreshToken: this.cipher.encrypt(token.refresh_token),
        accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 3_600) * 1000,
        createdAt: now,
        updatedAt: now
      }
      this.db.insert(snapchatAccounts).values(values).onConflictDoUpdate({
        target: [snapchatAccounts.tenant, snapchatAccounts.ownerId, snapchatAccounts.accountId],
        set: {
          profileId: values.profileId,
          displayName: values.displayName,
          handle: values.handle,
          avatarUrl: values.avatarUrl,
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          accessTokenExpiresAt: values.accessTokenExpiresAt,
          updatedAt: now
        }
      }).run()
      this.db.delete(snapchatOauthStates).where(eq(snapchatOauthStates.state, state)).run()
      return { status: 'connected', message: `Snapchat 公共主页“${values.displayName}”已连接` }
    } catch (error) {
      return this.failOauth(state, errorMessage(error))
    }
  }

  async oauthStatus(tenant: string, ownerId: number, accountId: string): Promise<
    | { status: 'connected'; account: SnapchatAccountView }
    | { status: 'authorizing' | 'error' | 'disconnected'; detail?: string }
  > {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (account) return { status: 'connected', account: toAccountView(account) }
    const pending = this.db.select().from(snapchatOauthStates).where(and(
      eq(snapchatOauthStates.tenant, tenant),
      eq(snapchatOauthStates.ownerId, ownerId),
      eq(snapchatOauthStates.accountId, accountId)
    )).orderBy(desc(snapchatOauthStates.createdAt)).get()
    if (!pending || pending.expiresAt < Date.now()) {
      return {
        status: 'disconnected',
        detail: this.available()
          ? '授权 Snapchat 品牌公共主页后，填写要联系的创作者 Public Profile ID。'
          : '服务器尚未配置 Snapchat Public Profile API 应用。'
      }
    }
    return pending.status === 'error'
      ? { status: 'error', detail: pending.error || 'Snapchat 授权失败。' }
      : { status: 'authorizing', detail: '请在浏览器完成 Snapchat 公共主页授权。' }
  }

  listAccounts(tenant: string, ownerId: number): SnapchatAccountView[] {
    return this.db.select().from(snapchatAccounts).where(and(
      eq(snapchatAccounts.tenant, tenant), eq(snapchatAccounts.ownerId, ownerId)
    )).orderBy(asc(snapchatAccounts.createdAt)).all().map(toAccountView)
  }

  disconnect(tenant: string, ownerId: number, accountId: string): void {
    assertAccountId(accountId)
    const filter = (table: typeof snapchatAccounts | typeof snapchatOauthStates | typeof snapchatConversations | typeof snapchatSentMessages) => and(
      eq(table.tenant, tenant), eq(table.ownerId, ownerId), eq(table.accountId, accountId)
    )
    this.db.delete(snapchatSentMessages).where(filter(snapchatSentMessages)).run()
    this.db.delete(snapchatConversations).where(filter(snapchatConversations)).run()
    this.db.delete(snapchatOauthStates).where(filter(snapchatOauthStates)).run()
    this.db.delete(snapchatAccounts).where(filter(snapchatAccounts)).run()
  }

  async connectCreators(
    tenant: string,
    ownerId: number,
    accountId: string,
    creatorProfileIds: string[]
  ): Promise<{ connected: number; conversations: SnapchatHistoryConversation[] }> {
    const ids = [...new Set(creatorProfileIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length > 100) throw new SnapchatServiceError('一次最多配置 100 个创作者 Public Profile ID。')
    for (const id of ids) if (!PROFILE_ID_RE.test(id)) throw new SnapchatServiceError(`非法创作者 Public Profile ID：${id}`)
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    let connected = 0
    for (const creatorId of ids) {
      const existing = this.db.select().from(snapchatConversations).where(and(
        eq(snapchatConversations.tenant, tenant), eq(snapchatConversations.ownerId, ownerId),
        eq(snapchatConversations.accountId, accountId), eq(snapchatConversations.creatorProfileId, creatorId)
      )).get()
      if (existing) continue
      const profile = await this.publicProfile(creatorId, token)
      const conversation = await this.getOrCreateConversation(account.profileId, creatorId, token)
      const now = Date.now()
      this.db.insert(snapchatConversations).values({
        tenant, ownerId, accountId,
        conversationId: conversation.id,
        conversationToken: this.cipher.encrypt(conversation.token),
        creatorProfileId: creatorId,
        creatorName: profile.name || profile.username || creatorId,
        creatorHandle: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [
          snapchatConversations.tenant, snapchatConversations.ownerId,
          snapchatConversations.accountId, snapchatConversations.conversationId
        ],
        set: {
          conversationToken: this.cipher.encrypt(conversation.token),
          creatorProfileId: creatorId,
          creatorName: profile.name || profile.username || creatorId,
          creatorHandle: profile.username ?? null,
          avatarUrl: profile.avatarUrl ?? null,
          updatedAt: now
        }
      }).run()
      connected++
    }
    return { connected, conversations: await this.history(tenant, ownerId, accountId) }
  }

  async history(tenant: string, ownerId: number, accountId: string): Promise<SnapchatHistoryConversation[]> {
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const rows = this.db.select().from(snapchatConversations).where(and(
      eq(snapchatConversations.tenant, tenant), eq(snapchatConversations.ownerId, ownerId),
      eq(snapchatConversations.accountId, accountId)
    )).orderBy(desc(snapchatConversations.updatedAt)).all()
    const sent = new Set(this.db.select({ id: snapchatSentMessages.messageId }).from(snapchatSentMessages).where(and(
      eq(snapchatSentMessages.tenant, tenant), eq(snapchatSentMessages.ownerId, ownerId),
      eq(snapchatSentMessages.accountId, accountId)
    )).all().map((item) => item.id))
    const result: SnapchatHistoryConversation[] = []
    for (const row of rows) {
      try {
        const messages = await this.conversationMessages(
          account.profileId, row.conversationId, this.cipher.decrypt(row.conversationToken), token
        )
        const normalized = messages.map((message, index) => normalizeMessage(
          message,
          account.profileId,
          sent,
          row.updatedAt - Math.max(0, messages.length - index - 1)
        ))
        const updatedTime = normalized.reduce((max, message) => Math.max(max, Number(message._timestamp || 0)), row.updatedAt)
        if (updatedTime !== row.updatedAt) {
          this.db.update(snapchatConversations).set({ updatedAt: updatedTime }).where(and(
            eq(snapchatConversations.tenant, tenant), eq(snapchatConversations.ownerId, ownerId),
            eq(snapchatConversations.accountId, accountId),
            eq(snapchatConversations.conversationId, row.conversationId)
          )).run()
        }
        result.push({
          externalChatId: row.conversationId,
          title: row.creatorName,
          publicId: row.creatorHandle ? `@${row.creatorHandle.replace(/^@/, '')}` : undefined,
          contactId: `snapchat:${account.profileId}:${row.creatorProfileId}`,
          avatarUrl: row.avatarUrl || undefined,
          updatedTime,
          messages: normalized
        })
      } catch {
        // 单个创作者会话异常不影响其他会话；下一轮会再次尝试。
      }
    }
    return result.sort((a, b) => b.updatedTime - a.updatedTime)
  }

  async sendText(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string,
    text: string
  ): Promise<{ messageId?: string }> {
    assertConversationId(conversationId)
    const clean = text.trim()
    if (!clean) throw new SnapchatServiceError('text required')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const row = this.db.select().from(snapchatConversations).where(and(
      eq(snapchatConversations.tenant, tenant), eq(snapchatConversations.ownerId, ownerId),
      eq(snapchatConversations.accountId, accountId), eq(snapchatConversations.conversationId, conversationId)
    )).get()
    if (!row) throw new SnapchatServiceError('Snapchat 创作者会话尚未绑定。', 404)
    const clientMessageId = randomUUID()
    const data = await this.api<Record<string, unknown>>(
      `/v1/public_profiles/${encodeURIComponent(account.profileId)}/group_conversation_messages`,
      this.cipher.decrypt(account.accessToken),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          token: this.cipher.decrypt(row.conversationToken),
          group_conversation_messages: [{
            type: 'TEXT', text_message: clean, message_id: clientMessageId
          }]
        })
      }
    )
    const messageId = messageIdFrom(data) || clientMessageId
    if (messageId) {
      this.db.insert(snapchatSentMessages).values({ tenant, ownerId, accountId, messageId, createdAt: Date.now() })
        .onConflictDoNothing().run()
    }
    return { messageId }
  }

  prune(): { oauth: number; sent: number } {
    const now = Date.now()
    return {
      oauth: this.db.delete(snapchatOauthStates).where(lt(snapchatOauthStates.expiresAt, now)).run().changes,
      sent: this.db.delete(snapchatSentMessages).where(lt(snapchatSentMessages.createdAt, now - SENT_TTL_MS)).run().changes
    }
  }

  private async myProfile(token: string): Promise<SnapProfile> {
    const data = await this.api<Record<string, unknown>>('/v1/public_profiles/my_profile', token)
    return normalizeProfile(firstProfile(data))
  }

  private async publicProfile(profileId: string, token: string): Promise<SnapProfile> {
    const data = await this.api<Record<string, unknown>>(
      `/v1/public_profiles/${encodeURIComponent(profileId)}`, token
    )
    const profile = normalizeProfile(firstProfile(data))
    return profile.id ? profile : { id: profileId }
  }

  private async getOrCreateConversation(
    brandProfileId: string,
    creatorProfileId: string,
    token: string
  ): Promise<{ id: string; token: string }> {
    const params = new URLSearchParams({ creator_profile_id: creatorProfileId })
    const data = await this.api<Record<string, unknown>>(
      `/v1/public_profiles/${encodeURIComponent(brandProfileId)}/group_conversation?${params}`, token
    )
    const raw = asRecord(data.group_conversation) || asRecord(data.conversation) || asRecord(data.data) || data
    const id = stringValue(raw.conversation_id) || stringValue(raw.id)
    const conversationToken = stringValue(raw.token) || stringValue(raw.conversation_token)
    if (!id || !conversationToken) {
      throw new SnapchatServiceError('Snapchat 未返回创作者会话 ID/token；请确认 Messaging API 白名单。', 403)
    }
    return { id, token: conversationToken }
  }

  private async conversationMessages(
    brandProfileId: string,
    conversationId: string,
    conversationToken: string,
    accessToken: string
  ): Promise<Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = []
    let cursor = ''
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        token: conversationToken,
        limit: '100'
      })
      if (cursor) params.set('cursor', cursor)
      const data = await this.api<Record<string, unknown>>(
        `/v1/public_profiles/${encodeURIComponent(brandProfileId)}/group_conversation_messages?${params}`,
        accessToken
      )
      for (const raw of arrayValue(data.group_conversation_messages || asRecord(data.data)?.group_conversation_messages || data.messages)) {
        const wrapper = asRecord(raw)
        const message = asRecord(wrapper?.group_conversation_message) || wrapper
        if (message) found.push(message)
      }
      const paging = asRecord(data.paging)
      const next = stringValue(data.next_cursor) || stringValue(paging?.next_cursor) ||
        stringValue(paging?.next_page_id) || ''
      if (!next || next === cursor) break
      cursor = next
    }
    return found
  }

  private async requireAccount(tenant: string, ownerId: number, accountId: string) {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (!account) throw new SnapchatServiceError('Snapchat 公共主页尚未授权。', 404)
    return account
  }

  private async loadAccount(tenant: string, ownerId: number, accountId: string, refresh: boolean) {
    let account = this.db.select().from(snapchatAccounts).where(and(
      eq(snapchatAccounts.tenant, tenant), eq(snapchatAccounts.ownerId, ownerId),
      eq(snapchatAccounts.accountId, accountId)
    )).get()
    if (!account || !refresh || account.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return account
    const token = await this.tokenRequest({
      grant_type: 'refresh_token', refresh_token: this.cipher.decrypt(account.refreshToken)
    })
    if (!token.access_token) throw new SnapchatServiceError('Snapchat 刷新令牌时没有返回 access_token。', 502)
    const now = Date.now()
    const updated = {
      accessToken: this.cipher.encrypt(token.access_token),
      refreshToken: token.refresh_token ? this.cipher.encrypt(token.refresh_token) : account.refreshToken,
      accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 3_600) * 1000,
      updatedAt: now
    }
    this.db.update(snapchatAccounts).set(updated).where(and(
      eq(snapchatAccounts.tenant, tenant), eq(snapchatAccounts.ownerId, ownerId),
      eq(snapchatAccounts.accountId, accountId)
    )).run()
    account = { ...account, ...updated }
    return account
  }

  private tokenRequest(fields: Record<string, string>): Promise<TokenData> {
    return this.requestJson<TokenData>(TOKEN_URL, undefined, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.snapchatClientId}:${this.config.snapchatClientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: this.config.snapchatClientId!,
        client_secret: this.config.snapchatClientSecret!,
        ...fields
      }).toString()
    })
  }

  private api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    return this.requestJson<T>(`${API_BASE}${path}`, token, init)
  }

  private async requestJson<T>(url: string, token?: string, init: RequestInit = {}): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...headersObject(init.headers), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: init.signal ?? AbortSignal.timeout(30_000)
      })
    } catch (error) {
      throw new SnapchatServiceError(`连接 Snapchat 失败：${errorMessage(error)}`, 502)
    }
    const raw = await response.text()
    let parsed: Record<string, unknown>
    try {
      parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    } catch {
      throw new SnapchatServiceError(`Snapchat 返回了无法解析的数据（HTTP ${response.status}）。`, 502)
    }
    const statusText = stringValue(parsed.request_status)?.toUpperCase()
    if (!response.ok || statusText === 'ERROR' || statusText === 'FAILURE') {
      const first = asRecord(arrayValue(parsed.errors)[0])
      const message = stringValue(parsed.error_description) || stringValue(parsed.message) ||
        stringValue(first?.message) || stringValue(first?.description) || `HTTP ${response.status}`
      throw new SnapchatServiceError(`Snapchat API：${message}`, response.status >= 500 ? 502 : response.status || 400)
    }
    return parsed as T
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new SnapchatServiceError(
        '服务器尚未配置 SNAPCHAT_CLIENT_ID / SNAPCHAT_CLIENT_SECRET / SNAPCHAT_TOKEN_ENCRYPTION_KEY。',
        503
      )
    }
  }

  private requireOauthState(state: string) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new SnapchatServiceError('非法 OAuth state。')
    const pending = this.db.select().from(snapchatOauthStates).where(eq(snapchatOauthStates.state, state)).get()
    if (!pending || pending.expiresAt < Date.now()) throw new SnapchatServiceError('授权已过期，请重新发起。', 410)
    return pending
  }

  private failOauth(state: string, message: string): SnapchatOauthResult {
    this.db.update(snapchatOauthStates).set({ status: 'error', error: message.slice(0, 500) })
      .where(eq(snapchatOauthStates.state, state)).run()
    return { status: 'error', message }
  }
}

class TokenCipher {
  readonly available: boolean
  private readonly key: Buffer

  constructor(material: string | undefined) {
    this.available = Boolean(material && material.length >= 32)
    this.key = createHash('sha256').update(material || 'disabled').digest()
  }

  encrypt(value: string): string {
    if (!this.available) throw new SnapchatServiceError('Snapchat 令牌加密密钥未配置或不足 32 位。', 503)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':')
  }

  decrypt(value: string): string {
    const [version, iv, tag, encrypted] = value.split(':')
    if (!this.available || version !== 'v1' || !iv || !tag || !encrypted) {
      throw new SnapchatServiceError('Snapchat 令牌密文损坏，请重新授权。', 500)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new SnapchatServiceError('Snapchat 令牌无法解密，请重新授权。', 500)
    }
  }
}

function toAccountView(account: typeof snapchatAccounts.$inferSelect): SnapchatAccountView {
  return {
    channel: 'snapchat', accountId: account.accountId, profileId: account.profileId,
    displayName: account.displayName, handle: account.handle || undefined,
    avatarUrl: account.avatarUrl || undefined
  }
}

function firstProfile(data: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(data.public_profile) || asRecord(data.profile) || asRecord(data.data)
  if (nested && (nested.profile_id || nested.id)) return nested
  const first = asRecord(arrayValue(data.public_profiles)[0]) || asRecord(arrayValue(asRecord(data.data)?.public_profiles)[0])
  return first || nested || data
}

function normalizeProfile(raw: Record<string, unknown>): SnapProfile {
  const logos = asRecord(raw.logo_urls)
  return {
    id: stringValue(raw.profile_id) || stringValue(raw.id) || '',
    name: stringValue(raw.display_name) || stringValue(raw.name) || stringValue(raw.title),
    username: stringValue(raw.username) || stringValue(raw.snapchat_username) || stringValue(raw.snap_user_name),
    avatarUrl: stringValue(raw.profile_image_url) || stringValue(raw.avatar_url) || stringValue(raw.logo_url) ||
      stringValue(logos?.manage_profile_logo_url) || stringValue(logos?.original_logo_url)
  }
}

function normalizeMessage(
  raw: Record<string, unknown>,
  brandProfileId: string,
  sent: Set<string>,
  fallbackTime: number
): Record<string, unknown> {
  const id = stringValue(raw.id) || stringValue(raw.message_id) ||
    createHash('sha256').update(JSON.stringify(raw)).digest('base64url').slice(0, 32)
  const senderId = stringValue(raw.sender_profile_id) || stringValue(raw.sender_id) || stringValue(asRecord(raw.sender)?.id)
  const declared = stringValue(raw.direction)?.toLowerCase()
  const direction = sent.has(id) || senderId === brandProfileId || declared === 'out' || declared === 'outbound'
    ? 'out'
    : 'in'
  const message = asRecord(raw.text_message)
  const text = stringValue(raw.text_message) || stringValue(raw.text) || stringValue(message?.text) || ''
  const ts = timestamp(raw.created_at || raw.sent_at || raw.timestamp) || fallbackTime
  return { ...raw, _id: id, _direction: direction, _text: text, _timestamp: ts }
}

function messageIdFrom(data: Record<string, unknown>): string | undefined {
  const wrapper = asRecord(arrayValue(data.group_conversation_messages)[0]) ||
    asRecord(arrayValue(asRecord(data.data)?.group_conversation_messages)[0]) || asRecord(data.message)
  const first = asRecord(wrapper?.group_conversation_message) || wrapper
  return stringValue(first?.id) || stringValue(first?.message_id) || stringValue(data.message_id)
}

function assertAccountId(value: string): void {
  if (!ACCOUNT_ID_RE.test(value)) throw new SnapchatServiceError('非法 accountId。')
}

function assertConversationId(value: string): void {
  if (!CONVERSATION_ID_RE.test(value)) throw new SnapchatServiceError('非法 Snapchat conversationId。')
}

function positiveSeconds(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function timestamp(value: unknown): number {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number > 1e12 ? number : number * 1000
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function headersObject(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
