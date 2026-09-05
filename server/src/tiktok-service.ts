import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import type { ServerConfig } from './config.ts'
import type { Db } from './db.ts'
import { tiktokAccounts, tiktokEvents, tiktokOauthStates } from './schema.ts'

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3'
const OAUTH_URL = 'https://ads.tiktok.com/marketing_api/auth'
const OAUTH_TTL_MS = 15 * 60 * 1000
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const WEBHOOK_MAX_AGE_SEC = 5 * 60
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const ID_RE = /^[^\u0000-\u001f]{1,512}$/

export interface TikTokAccountView {
  channel: 'tiktok'
  accountId: string
  businessId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

export interface TikTokOauthResult {
  status: 'connected' | 'error'
  message: string
}

export interface TikTokParticipant {
  role?: string
  id?: string
  display_name?: string
  profile_image?: string
  is_follower?: boolean
}

export interface TikTokMessage {
  message_id?: string
  conversation_id?: string
  sender?: string
  recipient?: string
  timestamp?: number
  message_type?: string
  type?: string
  from_user?: { role?: string; id?: string }
  to_user?: { role?: string; id?: string }
  unique_identifier?: string
  text?: { body?: string }
  image?: { media_id?: string }
  video?: { media_id?: string }
  sticker?: { url?: string }
  emoji?: { url?: string }
  share_post?: { embed_url?: string; video_id?: string }
  template?: { type?: string; title?: string; elements?: unknown[]; buttons?: unknown[] }
}

export interface TikTokHistoryConversation {
  externalChatId: string
  title: string
  publicId?: string
  contactId?: string
  avatarUrl?: string
  updatedTime: number
  messages: TikTokMessage[]
}

export interface TikTokProfile {
  id: string
  name?: string
  username?: string
  avatarUrl?: string
}

interface TokenData {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  open_id?: string
  scope?: string
}

interface BusinessProfileData {
  username?: string
  display_name?: string
  profile_image?: string
  is_business_account?: boolean
}

interface TikTokApiEnvelope<T> {
  code?: number | string
  message?: string
  request_id?: string
  data?: T
}

export class TikTokServiceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * TikTok Business Messaging 官方接入服务。
 *
 * OAuth、短期 access token、长期 refresh token、Webhook 和所有 API 请求都留在服务器；
 * 桌面端只能读取业务账号公开摘要和属于当前团队的消息事件。
 */
export class TikTokService {
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
      config.tiktokTokenEncryptionKey || config.metaTokenEncryptionKey || config.tiktokAppSecret
    )
  }

  available(): boolean {
    return Boolean(this.config.tiktokAppId && this.config.tiktokAppSecret && this.cipher.available)
  }

  oauthRedirectUri(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/oauth/tiktok/callback`
  }

  webhookUrl(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/webhook/tiktok`
  }

  beginOauth(tenant: string, ownerId: number, accountId: string): { url: string; expiresAt: number } {
    this.assertAvailable()
    assertAccountId(accountId)
    this.pruneOauth()
    this.db.delete(tiktokOauthStates).where(and(
      eq(tiktokOauthStates.tenant, tenant),
      eq(tiktokOauthStates.ownerId, ownerId),
      eq(tiktokOauthStates.accountId, accountId)
    )).run()

    const state = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + OAUTH_TTL_MS
    this.db.insert(tiktokOauthStates).values({
      state,
      tenant,
      ownerId,
      accountId,
      status: 'authorizing',
      expiresAt,
      createdAt: now
    }).run()

    const params = new URLSearchParams({
      app_id: this.config.tiktokAppId!,
      state,
      redirect_uri: this.oauthRedirectUri(),
      scope: [
        'message.list.read',
        'message.list.send',
        'user.info.basic',
        'user.info.username',
        'user.info.profile'
      ].join(',')
    })
    return { url: `${OAUTH_URL}?${params}`, expiresAt }
  }

  async oauthStatus(
    tenant: string,
    ownerId: number,
    accountId: string
  ): Promise<
    | { status: 'connected'; account: TikTokAccountView }
    | { status: 'authorizing' | 'error' | 'disconnected'; detail?: string }
  > {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (account) return { status: 'connected', account: toAccountView(account) }
    const pending = this.db.select().from(tiktokOauthStates).where(and(
      eq(tiktokOauthStates.tenant, tenant),
      eq(tiktokOauthStates.ownerId, ownerId),
      eq(tiktokOauthStates.accountId, accountId)
    )).orderBy(desc(tiktokOauthStates.createdAt)).get()
    if (!pending || pending.expiresAt < Date.now()) {
      return {
        status: 'disconnected',
        detail: this.available()
          ? '点击“授权并连接”，在浏览器登录要接入的 TikTok 企业号。'
          : '服务器尚未配置 TikTok API for Business 应用。'
      }
    }
    return pending.status === 'error'
      ? { status: 'error', detail: pending.error || 'TikTok 授权失败。' }
      : { status: 'authorizing', detail: '请在浏览器完成 TikTok 企业号授权；完成后这里会自动连接。' }
  }

  async completeOauth(state: string, authCode?: string, oauthError?: string): Promise<TikTokOauthResult> {
    const pending = this.requireOauthState(state)
    if (oauthError) return this.failOauth(state, oauthError)
    if (!authCode) return this.failOauth(state, '授权回调缺少 auth_code')
    try {
      const token = await this.exchangeCode(authCode)
      if (!token.access_token || !token.refresh_token || !token.open_id) {
        throw new TikTokServiceError('TikTok 没有返回完整的账号令牌。', 502)
      }
      const granted = new Set((token.scope || '').split(',').map((item) => item.trim()).filter(Boolean))
      if (granted.size > 0 && (!granted.has('message.list.read') || !granted.has('message.list.send'))) {
        throw new TikTokServiceError('当前授权缺少 TikTok 私信读取或发送权限，请确认应用审核与授权范围。')
      }
      const profile = await this.businessProfile(token.open_id, token.access_token)
      if (profile.is_business_account === false) {
        throw new TikTokServiceError('该账号不是 TikTok 企业号，Business Messaging 无法接入。')
      }
      // DIRECT_MESSAGE 是应用级订阅；重复 update 是幂等的，也能在改域名后自动修正回调。
      await this.registerWebhook()

      const now = Date.now()
      const displayName = profile.display_name || profile.username || 'TikTok Business'
      const values = {
        tenant: pending.tenant,
        ownerId: pending.ownerId,
        accountId: pending.accountId,
        businessId: token.open_id,
        displayName,
        handle: profile.username ?? null,
        avatarUrl: profile.profile_image ?? null,
        accessToken: this.cipher.encrypt(token.access_token),
        refreshToken: this.cipher.encrypt(token.refresh_token),
        accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 86_400) * 1000,
        refreshTokenExpiresAt: now + positiveSeconds(token.refresh_token_expires_in, 31_536_000) * 1000,
        createdAt: now,
        updatedAt: now
      }
      this.db.insert(tiktokAccounts).values(values).onConflictDoUpdate({
        target: [tiktokAccounts.tenant, tiktokAccounts.ownerId, tiktokAccounts.accountId],
        set: {
          businessId: values.businessId,
          displayName: values.displayName,
          handle: values.handle,
          avatarUrl: values.avatarUrl,
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          accessTokenExpiresAt: values.accessTokenExpiresAt,
          refreshTokenExpiresAt: values.refreshTokenExpiresAt,
          updatedAt: now
        }
      }).run()
      this.db.delete(tiktokOauthStates).where(eq(tiktokOauthStates.state, state)).run()
      return { status: 'connected', message: `TikTok 企业号“${displayName}”已连接` }
    } catch (error) {
      return this.failOauth(state, errorMessage(error))
    }
  }

  listAccounts(tenant: string, ownerId: number): TikTokAccountView[] {
    return this.db.select().from(tiktokAccounts).where(and(
      eq(tiktokAccounts.tenant, tenant),
      eq(tiktokAccounts.ownerId, ownerId)
    )).orderBy(asc(tiktokAccounts.createdAt)).all().map(toAccountView)
  }

  disconnect(tenant: string, ownerId: number, accountId: string): void {
    assertAccountId(accountId)
    const where = and(
      eq(tiktokAccounts.tenant, tenant),
      eq(tiktokAccounts.ownerId, ownerId),
      eq(tiktokAccounts.accountId, accountId)
    )
    this.db.delete(tiktokAccounts).where(where).run()
    this.db.delete(tiktokEvents).where(and(
      eq(tiktokEvents.tenant, tenant),
      eq(tiktokEvents.ownerId, ownerId),
      eq(tiktokEvents.accountId, accountId)
    )).run()
    this.db.delete(tiktokOauthStates).where(and(
      eq(tiktokOauthStates.tenant, tenant),
      eq(tiktokOauthStates.ownerId, ownerId),
      eq(tiktokOauthStates.accountId, accountId)
    )).run()
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    const secret = this.config.tiktokAppSecret
    if (!secret || !signatureHeader) return false
    const fields = new Map(
      signatureHeader.split(',').map((part) => {
        const separator = part.indexOf('=')
        return separator > 0
          ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
          : ['', '']
      })
    )
    const timestamp = fields.get('t') || ''
    const suppliedHex = fields.get('s') || ''
    if (!/^\d{9,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(suppliedHex)) return false
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
    if (!Number.isFinite(age) || age > WEBHOOK_MAX_AGE_SEC) return false
    const supplied = Buffer.from(suppliedHex, 'hex')
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  enqueueWebhook(payload: unknown): number {
    const root = asRecord(payload)
    const event = stringValue(root?.event)
    if (!event?.startsWith('im_')) return 0
    const parsedContent = parseContent(root?.content)
    const businessId = stringValue(root?.user_openid) || businessIdFromContent(parsedContent)
    if (!businessId) return 0
    const accounts = this.db.select().from(tiktokAccounts)
      .where(eq(tiktokAccounts.businessId, businessId)).all()
    if (accounts.length === 0) return 0
    const normalized = JSON.stringify({
      client_key: stringValue(root?.client_key),
      event,
      create_time: numberValue(root?.create_time),
      user_openid: businessId,
      content: parsedContent ?? root?.content
    })
    const now = Date.now()
    for (const account of accounts) {
      this.db.insert(tiktokEvents).values({
        tenant: account.tenant,
        ownerId: account.ownerId,
        accountId: account.accountId,
        payload: normalized,
        createdAt: now
      }).run()
    }
    return accounts.length
  }

  pullEvents(tenant: string, ownerId: number, accountId: string): unknown[] {
    assertAccountId(accountId)
    const rows = this.db.select().from(tiktokEvents).where(and(
      eq(tiktokEvents.tenant, tenant),
      eq(tiktokEvents.ownerId, ownerId),
      eq(tiktokEvents.accountId, accountId)
    )).orderBy(asc(tiktokEvents.id)).limit(500).all()
    if (rows.length > 0) {
      this.db.delete(tiktokEvents).where(inArray(tiktokEvents.id, rows.map((row) => row.id))).run()
    }
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload)]
      } catch {
        return []
      }
    })
  }

  async history(tenant: string, ownerId: number, accountId: string): Promise<TikTokHistoryConversation[]> {
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const summaries = new Map<string, number>()
    for (const type of ['STRANGER', 'SINGLE']) {
      for (const item of await this.conversations(account.businessId, token, type)) {
        const raw = asRecord(item)
        const id = stringValue(raw?.conversation_id)
        if (!id) continue
        summaries.set(id, Math.max(summaries.get(id) || 0, finiteTimestamp(raw?.update_time, 0)))
      }
    }

    const ordered = [...summaries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)
    const result: TikTokHistoryConversation[] = []
    // 每批 5 条：避免首次连接串行 100 个请求超时，也不制造 100 路并发触发平台限流。
    for (let offset = 0; offset < ordered.length; offset += 5) {
      const batch = await Promise.all(ordered.slice(offset, offset + 5).map(async ([conversationId, updatedTime]) => {
        try {
          const content = await this.conversationContent(account.businessId, conversationId, token)
          const participants = arrayValue(content.participants) as TikTokParticipant[]
          const messages = arrayValue(content.messages) as TikTokMessage[]
          const peer = participants.find((participant) =>
            String(participant?.role || '').toUpperCase() === 'PERSONAL_ACCOUNT'
          )
          const username = peerUsername(messages, account.businessId)
          const history: TikTokHistoryConversation = {
            externalChatId: conversationId,
            title: stringValue(peer?.display_name) || username || conversationId,
            publicId: username ? `@${username.replace(/^@/, '')}` : undefined,
            contactId: peer?.id ? `tiktok:${account.businessId}:${peer.id}` : undefined,
            avatarUrl: stringValue(peer?.profile_image) || undefined,
            updatedTime: updatedTime || newestMessageAt(messages),
            messages
          }
          return history
        } catch {
          // 单条会话异常不应让其余历史全部消失；Webhook 新消息仍会继续进入。
          return undefined
        }
      }))
      result.push(...batch.filter((item): item is TikTokHistoryConversation => Boolean(item)))
    }
    return result
  }

  async profile(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string
  ): Promise<TikTokProfile> {
    assertExternalId(conversationId, 'conversationId')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const content = await this.conversationContent(account.businessId, conversationId, token)
    const participants = arrayValue(content.participants) as TikTokParticipant[]
    const messages = arrayValue(content.messages) as TikTokMessage[]
    const peer = participants.find((participant) =>
      String(participant?.role || '').toUpperCase() === 'PERSONAL_ACCOUNT'
    )
    const username = peerUsername(messages, account.businessId)
    return {
      id: stringValue(peer?.id) || conversationId,
      name: stringValue(peer?.display_name) || username || undefined,
      username: username || undefined,
      avatarUrl: stringValue(peer?.profile_image) || undefined
    }
  }

  async sendText(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string,
    text: string
  ): Promise<{ messageId?: string }> {
    assertExternalId(conversationId, 'conversationId')
    if (!text.trim()) throw new TikTokServiceError('text required')
    if (text.length > 6_000) throw new TikTokServiceError('TikTok 消息不能超过 6000 字符。')
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const data = await this.apiData<Record<string, unknown>>('/business/message/send/', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        business_id: account.businessId,
        recipient_type: 'CONVERSATION',
        recipient: conversationId,
        message_type: 'TEXT',
        text: { body: text }
      })
    })
    return { messageId: messageIdFrom(data) }
  }

  async sendImage(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string,
    mimeType: string,
    dataBase64: string
  ): Promise<{ messageId?: string }> {
    assertExternalId(conversationId, 'conversationId')
    const normalizedMime = mimeType.split(';', 1)[0]?.trim().toLowerCase()
    if (normalizedMime !== 'image/jpeg' && normalizedMime !== 'image/png') {
      throw new TikTokServiceError('TikTok 官方接口仅支持发送 JPG 或 PNG 图片。')
    }
    const bytes = decodeImage(dataBase64)
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if ((normalizedMime === 'image/jpeg') !== isJpeg) {
      throw new TikTokServiceError('图片内容与声明的 MIME 类型不一致。')
    }
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const form = new FormData()
    form.set('business_id', account.businessId)
    form.set('media_type', 'IMAGE')
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: normalizedMime }),
      normalizedMime === 'image/png' ? 'image.png' : 'image.jpg'
    )
    const upload = await this.apiData<Record<string, unknown>>(
      '/business/message/media/upload/',
      token,
      { method: 'POST', body: form }
    )
    const mediaId = stringValue(upload.media_id)
    if (!mediaId) throw new TikTokServiceError('TikTok 上传图片后未返回 media_id。', 502)
    const data = await this.apiData<Record<string, unknown>>('/business/message/send/', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        business_id: account.businessId,
        recipient_type: 'CONVERSATION',
        recipient: conversationId,
        message_type: 'IMAGE',
        image: { media_id: mediaId }
      })
    })
    return { messageId: messageIdFrom(data) }
  }

  async downloadMedia(
    tenant: string,
    ownerId: number,
    accountId: string,
    conversationId: string,
    messageId: string,
    mediaId: string,
    mediaType: 'IMAGE' | 'VIDEO'
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    for (const [name, value] of Object.entries({ conversationId, messageId, mediaId })) {
      assertExternalId(value, name)
    }
    const account = await this.requireAccount(tenant, ownerId, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const data = await this.apiData<Record<string, unknown>>('/business/message/media/download/', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        business_id: account.businessId,
        conversation_id: conversationId,
        message_id: messageId,
        media_id: mediaId,
        media_type: mediaType
      })
    })
    const downloadUrl = stringValue(data.download_url)
    if (!downloadUrl || !safeDownloadUrl(downloadUrl)) {
      throw new TikTokServiceError('TikTok 返回的媒体下载地址无效。', 502)
    }
    let response: Response
    try {
      response = await this.fetchImpl(downloadUrl, {
        headers: { 'x-user': token },
        signal: AbortSignal.timeout(30_000)
      })
    } catch (error) {
      throw new TikTokServiceError(`下载 TikTok 媒体失败：${errorMessage(error)}`, 502)
    }
    if (!response.ok) throw new TikTokServiceError(`下载 TikTok 媒体失败（HTTP ${response.status}）。`, 502)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_DOWNLOAD_BYTES) throw new TikTokServiceError('TikTok 媒体超过 50 MB 限制。', 413)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new TikTokServiceError('TikTok 媒体为空或超过 50 MB 限制。', 413)
    }
    const fallback = mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg'
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0] || fallback
    return { bytes, mimeType }
  }

  prune(): { oauth: number; events: number } {
    const now = Date.now()
    return {
      oauth: this.db.delete(tiktokOauthStates).where(lt(tiktokOauthStates.expiresAt, now)).run().changes,
      events: this.db.delete(tiktokEvents).where(lt(tiktokEvents.createdAt, now - EVENT_TTL_MS)).run().changes
    }
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new TikTokServiceError(
        '服务器尚未配置 TIKTOK_APP_ID / TIKTOK_APP_SECRET / TikTok 令牌加密密钥。',
        503
      )
    }
  }

  private requireOauthState(state: string) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new TikTokServiceError('非法 OAuth state')
    const pending = this.db.select().from(tiktokOauthStates)
      .where(eq(tiktokOauthStates.state, state)).get()
    if (!pending || pending.expiresAt < Date.now()) {
      throw new TikTokServiceError('授权已过期，请回到客户端重新发起。', 410)
    }
    return pending
  }

  private failOauth(state: string, message: string): TikTokOauthResult {
    this.db.update(tiktokOauthStates).set({ status: 'error', error: message.slice(0, 500) })
      .where(eq(tiktokOauthStates.state, state)).run()
    return { status: 'error', message }
  }

  private exchangeCode(authCode: string): Promise<TokenData> {
    return this.apiData<TokenData>('/tt_user/oauth2/token/', undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.tiktokAppId,
        client_secret: this.config.tiktokAppSecret,
        grant_type: 'authorization_code',
        auth_code: authCode,
        redirect_uri: this.oauthRedirectUri()
      })
    })
  }

  private async registerWebhook(): Promise<void> {
    await this.apiData('/business/webhook/update/', undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.tiktokAppId,
        secret: this.config.tiktokAppSecret,
        event_type: 'DIRECT_MESSAGE',
        callback_url: this.webhookUrl()
      })
    })
  }

  private async businessProfile(businessId: string, token: string): Promise<BusinessProfileData> {
    const params = new URLSearchParams({
      business_id: businessId,
      fields: JSON.stringify(['username', 'display_name', 'profile_image', 'is_business_account'])
    })
    const data = await this.apiData<Record<string, unknown>>(`/business/get/?${params}`, token)
    return (asRecord(data.business) || asRecord(data.user) || data) as BusinessProfileData
  }

  private async conversations(businessId: string, token: string, type: string): Promise<unknown[]> {
    const found: unknown[] = []
    let cursor = 0
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        business_id: businessId,
        conversation_type: type,
        limit: '100',
        cursor: String(cursor)
      })
      const data = await this.apiData<Record<string, unknown>>(
        `/business/message/conversation/list/?${params}`,
        token
      )
      found.push(...arrayValue(data.conversations))
      if (!data.has_more) break
      const next = Number(data.cursor)
      if (!Number.isFinite(next) || next === cursor) break
      cursor = next
    }
    return found
  }

  private conversationContent(
    businessId: string,
    conversationId: string,
    token: string
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ business_id: businessId, conversation_id: conversationId })
    return this.apiData(`/business/message/content/list/?${params}`, token)
  }

  private async requireAccount(tenant: string, ownerId: number, accountId: string) {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, accountId, true)
    if (!account) throw new TikTokServiceError('TikTok 账号尚未授权或授权已过期。', 404)
    return account
  }

  private async loadAccount(tenant: string, ownerId: number, accountId: string, refresh: boolean) {
    let account = this.db.select().from(tiktokAccounts).where(and(
      eq(tiktokAccounts.tenant, tenant),
      eq(tiktokAccounts.ownerId, ownerId),
      eq(tiktokAccounts.accountId, accountId)
    )).get()
    if (!account || !refresh || account.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return account
    }
    if (account.refreshTokenExpiresAt <= Date.now()) {
      this.db.delete(tiktokAccounts).where(and(
        eq(tiktokAccounts.tenant, tenant),
        eq(tiktokAccounts.ownerId, ownerId),
        eq(tiktokAccounts.accountId, accountId)
      )).run()
      return undefined
    }
    try {
      const refreshToken = this.cipher.decrypt(account.refreshToken)
      const token = await this.apiData<TokenData>('/tt_user/oauth2/refresh_token/', undefined, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.tiktokAppId,
          client_secret: this.config.tiktokAppSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        })
      })
      if (!token.access_token) throw new TikTokServiceError('TikTok 刷新令牌时没有返回 access_token。', 502)
      const now = Date.now()
      const accessToken = this.cipher.encrypt(token.access_token)
      const rotatedRefresh = token.refresh_token ? this.cipher.encrypt(token.refresh_token) : account.refreshToken
      const updated = {
        accessToken,
        refreshToken: rotatedRefresh,
        accessTokenExpiresAt: now + positiveSeconds(token.expires_in, 86_400) * 1000,
        refreshTokenExpiresAt: token.refresh_token_expires_in
          ? now + positiveSeconds(token.refresh_token_expires_in, 31_536_000) * 1000
          : account.refreshTokenExpiresAt,
        updatedAt: now
      }
      this.db.update(tiktokAccounts).set(updated).where(and(
        eq(tiktokAccounts.tenant, tenant),
        eq(tiktokAccounts.ownerId, ownerId),
        eq(tiktokAccounts.accountId, accountId)
      )).run()
      account = { ...account, ...updated }
    } catch (error) {
      // 旧 access token 尚未真正到期时允许短暂网络故障，下次调用继续刷新。
      if (account.accessTokenExpiresAt <= Date.now()) throw error
    }
    return account
  }

  private async apiData<T = Record<string, unknown>>(
    path: string,
    accessToken?: string,
    init: RequestInit = {}
  ): Promise<T> {
    const url = path.startsWith('https://') ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...headersObject(init.headers),
          ...(accessToken ? { 'Access-Token': accessToken } : {})
        },
        signal: init.signal ?? AbortSignal.timeout(30_000)
      })
    } catch (error) {
      throw new TikTokServiceError(`连接 TikTok 失败：${errorMessage(error)}`, 502)
    }
    const raw = await response.text()
    let envelope: TikTokApiEnvelope<T>
    try {
      envelope = (raw ? JSON.parse(raw) : {}) as TikTokApiEnvelope<T>
    } catch {
      throw new TikTokServiceError(`TikTok 返回了无法解析的数据（HTTP ${response.status}）。`, 502)
    }
    const code = Number(envelope.code ?? 0)
    if (!response.ok || code !== 0) {
      const message = envelope.message || `HTTP ${response.status}`
      throw new TikTokServiceError(`TikTok API：${message}`, response.status >= 500 ? 502 : 400)
    }
    return (envelope.data ?? ({} as T))
  }

  private pruneOauth(): void {
    this.db.delete(tiktokOauthStates).where(lt(tiktokOauthStates.expiresAt, Date.now())).run()
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
    if (!this.available) throw new TikTokServiceError('TikTok 令牌加密密钥未配置或不足 32 位。', 503)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url')
    ].join(':')
  }

  decrypt(value: string): string {
    if (!this.available) throw new TikTokServiceError('TikTok 令牌加密密钥未配置。', 503)
    const [version, iv, tag, encrypted] = value.split(':')
    if (version !== 'v1' || !iv || !tag || !encrypted) {
      throw new TikTokServiceError('TikTok 令牌密文损坏，请重新授权。', 500)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final()
      ]).toString('utf8')
    } catch {
      throw new TikTokServiceError('TikTok 令牌无法解密，请重新授权。', 500)
    }
  }
}

function toAccountView(account: typeof tiktokAccounts.$inferSelect): TikTokAccountView {
  return {
    channel: 'tiktok',
    accountId: account.accountId,
    businessId: account.businessId,
    displayName: account.displayName,
    handle: account.handle || undefined,
    avatarUrl: account.avatarUrl || undefined
  }
}

function messageIdFrom(data: Record<string, unknown>): string | undefined {
  return stringValue(asRecord(data.message)?.message_id) || stringValue(data.message_id) || undefined
}

function parseContent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  return asRecord(value)
}

function businessIdFromContent(content: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['from_user', 'to_user']) {
    const user = asRecord(content?.[key])
    if (String(user?.role || '').toLowerCase() === 'business_account') {
      return stringValue(user?.id)
    }
  }
  return undefined
}

function peerUsername(messages: TikTokMessage[], businessId: string): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const fromBusiness = String(message.from_user?.role || '').toUpperCase() === 'BUSINESS_ACCOUNT' ||
      message.from_user?.id === businessId
    const username = fromBusiness ? message.recipient : message.sender
    if (username) return username
  }
  return undefined
}

function newestMessageAt(messages: TikTokMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, finiteTimestamp(message.timestamp, 0)), 0)
}

function safeDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' &&
      !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^169\.254\./.test(host) &&
      !/^172\.(1[6-9]|2\d|3[01])\./.test(host)
  } catch {
    return false
  }
}

function decodeImage(value: string): Buffer {
  if (!value || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) {
    throw new TikTokServiceError('TikTok 图片不能为空且不能超过 3 MB。', 413)
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new TikTokServiceError('图片 Base64 非法。')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new TikTokServiceError('TikTok 图片不能为空且不能超过 3 MB。', 413)
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (!jpeg && !png) throw new TikTokServiceError('图片内容不是有效的 JPG 或 PNG。')
  return bytes
}

function assertAccountId(value: string): void {
  if (!ACCOUNT_ID_RE.test(value)) throw new TikTokServiceError('非法 accountId')
}

function assertExternalId(value: string, name: string): void {
  if (!ID_RE.test(value)) throw new TikTokServiceError(`${name} 非法`)
}

function positiveSeconds(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function finiteTimestamp(value: unknown, fallback = Date.now()): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function headersObject(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
