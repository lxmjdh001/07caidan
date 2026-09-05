import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, lt } from 'drizzle-orm'
import type { ServerConfig } from './config.ts'
import type { Db } from './db.ts'
import { xAccounts, xOauthStates } from './schema.ts'

const API_BASE = 'https://api.x.com/2'
const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'
const TOKEN_URL = 'https://api.x.com/2/oauth2/token'
const OAUTH_TTL_MS = 15 * 60 * 1000
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const USER_ID_RE = /^\d{1,32}$/
const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/

export interface XAccountView {
  channel: 'x'
  accountId: string
  userId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

export interface XOauthResult {
  status: 'connected' | 'error'
  message: string
}

export interface XMedia {
  mediaKey?: string
  type?: string
  url?: string
  previewImageUrl?: string
  mimeType?: string
}

export interface XMessage {
  id?: string
  event_type?: string
  text?: string
  sender_id?: string
  dm_conversation_id?: string
  created_at?: string
  participant_ids?: string[]
  attachments?: { media_keys?: string[] }
  _media?: XMedia[]
}

export interface XHistoryConversation {
  externalChatId: string
  title: string
  publicId?: string
  contactId?: string
  avatarUrl?: string
  isGroup: boolean
  updatedTime: number
  messages: XMessage[]
}

interface XUser {
  id?: string
  name?: string
  username?: string
  profile_image_url?: string
}

interface TokenData {
  token_type?: string
  expires_in?: number
  access_token?: string
  scope?: string
  refresh_token?: string
}

export class XServiceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** X 官方 OAuth 2.0 + Direct Messages 接入；平台令牌永不下发到桌面端。 */
export class XService {
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
      config.xTokenEncryptionKey || config.metaTokenEncryptionKey || config.xClientSecret
    )
  }

  available(): boolean {
    return Boolean(this.config.xClientId && this.config.xClientSecret && this.cipher.available)
  }

  oauthRedirectUri(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/oauth/x/callback`
  }

  beginOauth(tenant: string, ownerId: number, accountId: string): { url: string; expiresAt: number } {
    this.assertAvailable()
    assertAccountId(accountId)
    this.prune()
    this.db.delete(xOauthStates).where(and(
      eq(xOauthStates.tenant, tenant),
      eq(xOauthStates.ownerId, ownerId),
      eq(xOauthStates.accountId, accountId)
    )).run()

    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const now = Date.now()
    const expiresAt = now + OAUTH_TTL_MS
    this.db.insert(xOauthStates).values({
      state,
      tenant,
      ownerId,
      accountId,
      codeVerifier,
      status: 'authorizing',
      expiresAt,
      createdAt: now
    }).run()

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.xClientId!,
      redirect_uri: this.oauthRedirectUri(),
      scope: 'dm.read dm.write tweet.read users.read offline.access media.write',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    return { url: `${AUTHORIZE_URL}?${params}`, expiresAt }
  }

  async completeOauth(state: string, code?: string, oauthError?: string): Promise<XOauthResult> {
    const pending = this.requireOauthState(state)
    if (oauthError) return this.failOauth(state, oauthError)
    if (!code) return this.failOauth(state, '授权回调缺少 code。')
    try {
      const token = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.oauthRedirectUri(),
        code_verifier: pending.codeVerifier
      })
      if (!token.access_token || !token.refresh_token) {
        throw new XServiceError('X 没有返回完整的 access/refresh token；请确认已申请 offline.access。', 502)
      }
      const granted = new Set((token.scope || '').split(/\s+/).filter(Boolean))
      if (granted.size > 0 && (!granted.has('dm.read') || !granted.has('dm.write'))) {
        throw new XServiceError('当前授权缺少 X 私信读取或发送权限。')
      }
      const profile = await this.me(token.access_token)
      if (!profile.id) throw new XServiceError('X 没有返回账号 ID。', 502)
      const now = Date.now()
      const values = {
        tenant: pending.tenant,
        ownerId: pending.ownerId,
        accountId: pending.accountId,
        userId: profile.id,
        displayName: profile.name || profile.username || 'X',
        handle: profile.username ?? null,
        avatarUrl: profile.profile_image_url ?? null,
        accessToken: this.cipher.encrypt(token.access_token),
        refreshToken: this.cipher.encrypt(token.refresh_token),
        accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 7_200) * 1000,
        createdAt: now,
        updatedAt: now
      }
      this.db.insert(xAccounts).values(values).onConflictDoUpdate({
        target: [xAccounts.tenant, xAccounts.ownerId, xAccounts.accountId],
        set: {
          userId: values.userId,
          displayName: values.displayName,
          handle: values.handle,
          avatarUrl: values.avatarUrl,
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          accessTokenExpiresAt: values.accessTokenExpiresAt,
          updatedAt: now
        }
      }).run()
      this.db.delete(xOauthStates).where(eq(xOauthStates.state, state)).run()
      return { status: 'connected', message: `X 账号“${values.displayName}”已连接` }
    } catch (error) {
      return this.failOauth(state, errorMessage(error))
    }
  }

  async oauthStatus(tenant: string, ownerId: number, accountId: string): Promise<
    | { status: 'connected'; account: XAccountView }
    | { status: 'authorizing' | 'error' | 'disconnected'; detail?: string }
  > {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (account) return { status: 'connected', account: toAccountView(account) }
    const pending = this.db.select().from(xOauthStates).where(and(
      eq(xOauthStates.tenant, tenant),
      eq(xOauthStates.ownerId, ownerId),
      eq(xOauthStates.accountId, accountId)
    )).orderBy(desc(xOauthStates.createdAt)).get()
    if (!pending || pending.expiresAt < Date.now()) {
      return {
        status: 'disconnected',
        detail: this.available()
          ? '点击“授权并连接”，在 X 网页确认私信权限。'
          : '服务器尚未配置 X OAuth 应用。'
      }
    }
    return pending.status === 'error'
      ? { status: 'error', detail: pending.error || 'X 授权失败。' }
      : { status: 'authorizing', detail: '请在浏览器完成 X 授权；完成后客户端会自动连接。' }
  }

  listAccounts(tenant: string, ownerId: number): XAccountView[] {
    return this.db.select().from(xAccounts).where(and(
      eq(xAccounts.tenant, tenant),
      eq(xAccounts.ownerId, ownerId)
    )).orderBy(asc(xAccounts.createdAt)).all().map(toAccountView)
  }

  disconnect(tenant: string, ownerId: number, accountId: string): void {
    assertAccountId(accountId)
    this.db.delete(xAccounts).where(and(
      eq(xAccounts.tenant, tenant), eq(xAccounts.ownerId, ownerId), eq(xAccounts.accountId, accountId)
    )).run()
    this.db.delete(xOauthStates).where(and(
      eq(xOauthStates.tenant, tenant), eq(xOauthStates.ownerId, ownerId), eq(xOauthStates.accountId, accountId)
    )).run()
  }

  async history(tenant: string, ownerId: number, accountId: string): Promise<XHistoryConversation[]> {
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const messages: XMessage[] = []
    const users = new Map<string, XUser>()
    const media = new Map<string, XMedia>()
    let paginationToken = ''

    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        max_results: '100',
        event_types: 'MessageCreate',
        'dm_event.fields': 'id,event_type,text,created_at,dm_conversation_id,sender_id,participant_ids,attachments',
        expansions: 'sender_id,participant_ids,attachments.media_keys',
        'user.fields': 'id,name,username,profile_image_url',
        'media.fields': 'media_key,type,url,preview_image_url,variants'
      })
      if (paginationToken) params.set('pagination_token', paginationToken)
      const pageData = await this.api<Record<string, unknown>>(`/dm_events?${params}`, token)
      for (const raw of arrayValue(pageData.data)) {
        const message = raw as XMessage
        if (message.event_type === 'MessageCreate' || !message.event_type) messages.push(message)
      }
      const includes = asRecord(pageData.includes)
      for (const raw of arrayValue(includes?.users)) {
        const user = raw as XUser
        if (user.id) users.set(user.id, user)
      }
      for (const raw of arrayValue(includes?.media)) {
        const item = normalizeMedia(raw)
        if (item.mediaKey) media.set(item.mediaKey, item)
      }
      paginationToken = stringValue(asRecord(pageData.meta)?.next_token) || ''
      if (!paginationToken) break
    }

    const groups = new Map<string, XMessage[]>()
    const participantIds = new Set<string>()
    for (const message of messages) {
      const conversationId = message.dm_conversation_id
      if (!conversationId || !CONVERSATION_ID_RE.test(conversationId)) continue
      const enriched = enrichMedia(message, media)
      const current = groups.get(conversationId) || []
      current.push(enriched)
      groups.set(conversationId, current)
      for (const id of peersFor(conversationId, message, account.userId)) participantIds.add(id)
    }
    const missing = [...participantIds].filter((id) => !users.has(id) && USER_ID_RE.test(id))
    for (let offset = 0; offset < missing.length; offset += 100) {
      const params = new URLSearchParams({
        ids: missing.slice(offset, offset + 100).join(','),
        'user.fields': 'id,name,username,profile_image_url'
      })
      const data = await this.api<Record<string, unknown>>(`/users?${params}`, token)
      for (const raw of arrayValue(data.data)) {
        const user = raw as XUser
        if (user.id) users.set(user.id, user)
      }
    }

    return [...groups.entries()].map(([externalChatId, items]) => {
      items.sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at))
      const ids = new Set(items.flatMap((message) => peersFor(externalChatId, message, account.userId)))
      const peers = [...ids].map((id) => users.get(id) || { id })
      const direct = peers.length === 1
      const peer = direct ? peers[0] : undefined
      const title = direct
        ? peer?.name || (peer?.username ? `@${peer.username}` : peer?.id) || externalChatId
        : peers.map((item) => item.name || (item.username ? `@${item.username}` : item.id)).filter(Boolean).join(', ') || 'X 群聊'
      return {
        externalChatId,
        title,
        publicId: direct && peer?.username ? `@${peer.username}` : undefined,
        contactId: direct && peer?.id ? `x:${peer.id}` : undefined,
        avatarUrl: direct ? peer?.profile_image_url : undefined,
        isGroup: !direct,
        updatedTime: items.reduce((max, item) => Math.max(max, timestamp(item.created_at)), 0),
        messages: items
      }
    }).sort((a, b) => b.updatedTime - a.updatedTime)
  }

  async profile(tenant: string, ownerId: number, accountId: string, userId: string): Promise<XUser> {
    if (!USER_ID_RE.test(userId)) throw new XServiceError('非法 X 用户 ID。')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const params = new URLSearchParams({ 'user.fields': 'id,name,username,profile_image_url' })
    const data = await this.api<Record<string, unknown>>(`/users/${userId}?${params}`, token)
    return (asRecord(data.data) || {}) as XUser
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
    if (!clean) throw new XServiceError('text required')
    if (clean.length > 10_000) throw new XServiceError('X 私信不能超过 10000 字符。')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const data = await this.api<Record<string, unknown>>(
      `/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
      this.cipher.decrypt(account.accessToken),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: clean }) }
    )
    return { messageId: eventId(data) }
  }

  async sendImage(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string,
    mimeType: string,
    dataBase64: string,
    text?: string
  ): Promise<{ messageId?: string }> {
    assertConversationId(conversationId)
    const mime = mimeType.split(';', 1)[0]?.trim().toLowerCase() || ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      throw new XServiceError('X 私信图片仅支持 JPG、PNG 或 WebP。')
    }
    const bytes = decodeBase64(dataBase64)
    if (!imageMatches(bytes, mime)) throw new XServiceError('图片内容与声明的 MIME 类型不一致。')
    if (text && text.trim().length > 10_000) throw new XServiceError('X 私信不能超过 10000 字符。')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const uploaded = await this.api<Record<string, unknown>>('/media/upload', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media: bytes.toString('base64'),
        media_category: 'dm_image'
      })
    })
    const uploadData = asRecord(uploaded.data) || uploaded
    const mediaId = stringValue(uploadData.id) || stringValue(uploadData.media_id_string)
    if (!mediaId) throw new XServiceError('X 上传图片后未返回 media_id。', 502)
    const sent = await this.api<Record<string, unknown>>(
      `/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(text?.trim() ? { text: text.trim() } : {}),
          attachments: [{ media_id: mediaId }]
        })
      }
    )
    return { messageId: eventId(sent) }
  }

  prune(): { oauth: number } {
    return { oauth: this.db.delete(xOauthStates).where(lt(xOauthStates.expiresAt, Date.now())).run().changes }
  }

  private async me(token: string): Promise<XUser> {
    const data = await this.api<Record<string, unknown>>(
      '/users/me?user.fields=id,name,username,profile_image_url', token
    )
    return (asRecord(data.data) || {}) as XUser
  }

  private async requireAccount(tenant: string, ownerId: number, accountId: string) {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (!account) throw new XServiceError('X 账号尚未授权。', 404)
    return account
  }

  private async loadAccount(tenant: string, ownerId: number, accountId: string, refresh: boolean) {
    let account = this.db.select().from(xAccounts).where(and(
      eq(xAccounts.tenant, tenant), eq(xAccounts.ownerId, ownerId), eq(xAccounts.accountId, accountId)
    )).get()
    if (!account || !refresh || account.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return account
    const currentRefresh = this.cipher.decrypt(account.refreshToken)
    const token = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: currentRefresh })
    if (!token.access_token) throw new XServiceError('X 刷新令牌时没有返回 access_token。', 502)
    const now = Date.now()
    const updated = {
      accessToken: this.cipher.encrypt(token.access_token),
      refreshToken: token.refresh_token ? this.cipher.encrypt(token.refresh_token) : account.refreshToken,
      accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 7_200) * 1000,
      updatedAt: now
    }
    this.db.update(xAccounts).set(updated).where(and(
      eq(xAccounts.tenant, tenant), eq(xAccounts.ownerId, ownerId), eq(xAccounts.accountId, accountId)
    )).run()
    account = { ...account, ...updated }
    return account
  }

  private tokenRequest(fields: Record<string, string>): Promise<TokenData> {
    return this.requestJson<TokenData>(TOKEN_URL, undefined, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.xClientId}:${this.config.xClientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ client_id: this.config.xClientId!, ...fields }).toString()
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
      throw new XServiceError(`连接 X 失败：${errorMessage(error)}`, 502)
    }
    const raw = await response.text()
    let parsed: Record<string, unknown>
    try {
      parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    } catch {
      throw new XServiceError(`X 返回了无法解析的数据（HTTP ${response.status}）。`, 502)
    }
    if (!response.ok) {
      const first = asRecord(arrayValue(parsed.errors)[0])
      const message = stringValue(parsed.detail) || stringValue(parsed.error_description) ||
        stringValue(first?.detail) || stringValue(first?.message) || stringValue(parsed.title) || `HTTP ${response.status}`
      throw new XServiceError(`X API：${message}`, response.status >= 500 ? 502 : response.status)
    }
    return parsed as T
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new XServiceError('服务器尚未配置 X_CLIENT_ID / X_CLIENT_SECRET / X_TOKEN_ENCRYPTION_KEY。', 503)
    }
  }

  private requireOauthState(state: string) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new XServiceError('非法 OAuth state。')
    const pending = this.db.select().from(xOauthStates).where(eq(xOauthStates.state, state)).get()
    if (!pending || pending.expiresAt < Date.now()) throw new XServiceError('授权已过期，请重新发起。', 410)
    return pending
  }

  private failOauth(state: string, message: string): XOauthResult {
    this.db.update(xOauthStates).set({ status: 'error', error: message.slice(0, 500) })
      .where(eq(xOauthStates.state, state)).run()
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
    if (!this.available) throw new XServiceError('X 令牌加密密钥未配置或不足 32 位。', 503)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':')
  }

  decrypt(value: string): string {
    const [version, iv, tag, encrypted] = value.split(':')
    if (!this.available || version !== 'v1' || !iv || !tag || !encrypted) {
      throw new XServiceError('X 令牌密文损坏，请重新授权。', 500)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new XServiceError('X 令牌无法解密，请重新授权。', 500)
    }
  }
}

function toAccountView(account: typeof xAccounts.$inferSelect): XAccountView {
  return {
    channel: 'x', accountId: account.accountId, userId: account.userId,
    displayName: account.displayName, handle: account.handle || undefined,
    avatarUrl: account.avatarUrl || undefined
  }
}

function peersFor(conversationId: string, message: XMessage, selfId: string): string[] {
  const ids = new Set<string>(message.participant_ids || [])
  if (message.sender_id) ids.add(message.sender_id)
  for (const part of conversationId.split('-')) if (USER_ID_RE.test(part)) ids.add(part)
  ids.delete(selfId)
  return [...ids]
}

function enrichMedia(message: XMessage, media: Map<string, XMedia>): XMessage {
  const found = (message.attachments?.media_keys || []).map((key) => media.get(key)).filter((item): item is XMedia => Boolean(item))
  return found.length > 0 ? { ...message, _media: found } : message
}

function normalizeMedia(value: unknown): XMedia {
  const raw = asRecord(value) || {}
  const variants = arrayValue(raw.variants).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
  const video = variants.filter((item) => stringValue(item.url)).sort((a, b) => Number(b.bit_rate || 0) - Number(a.bit_rate || 0))[0]
  return {
    mediaKey: stringValue(raw.media_key),
    type: stringValue(raw.type),
    url: stringValue(raw.url) || stringValue(video?.url),
    previewImageUrl: stringValue(raw.preview_image_url),
    mimeType: stringValue(video?.content_type)
  }
}

function eventId(value: Record<string, unknown>): string | undefined {
  const data = asRecord(value.data)
  return stringValue(data?.dm_event_id) || stringValue(data?.id) || stringValue(value.dm_event_id)
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32) {
    throw new XServiceError('X 图片不能为空且不能超过 5 MB。', 413)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new XServiceError('X 图片不能为空且不能超过 5 MB。', 413)
  return bytes
}

function imageMatches(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  return mime === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function assertAccountId(value: string): void {
  if (!ACCOUNT_ID_RE.test(value)) throw new XServiceError('非法 accountId。')
}

function assertConversationId(value: string): void {
  if (!CONVERSATION_ID_RE.test(value)) throw new XServiceError('非法 X conversationId。')
}

function positiveSeconds(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
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
