import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import type { ServerConfig } from './config.ts'
import type { Db } from './db.ts'
import { metaAccounts, metaEvents, metaOauthStates } from './schema.ts'

export type MetaChannel = 'facebook' | 'instagram'

const OAUTH_TTL_MS = 15 * 60 * 1000
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const IG_REFRESH_AFTER_MS = 45 * 24 * 60 * 60 * 1000
const STAGED_MEDIA_TTL_MS = 60 * 60 * 1000
const STAGED_MEDIA_PRUNE_MS = 2 * 60 * 60 * 1000
const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export type MetaOutboundMediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export interface MetaAccountView {
  channel: MetaChannel
  accountId: string
  assetId: string
  pageId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

export interface MetaOauthResult {
  status: 'connected' | 'selecting' | 'error'
  message: string
  resources?: Array<{ id: string; name: string; handle?: string; avatarUrl?: string }>
}

export interface MetaProfile {
  id: string
  name?: string
  username?: string
  avatarUrl?: string
}

export interface MetaHistoryAttachment {
  type: string
  url?: string
  name?: string
  mimeType?: string
}

export interface MetaHistoryMessage {
  id: string
  createdTime: number
  fromId?: string
  fromName?: string
  toIds: string[]
  text?: string
  attachments: MetaHistoryAttachment[]
}

export interface MetaHistoryConversation {
  externalChatId: string
  title: string
  updatedTime: number
  messages: MetaHistoryMessage[]
}

interface OauthResource {
  id: string
  assetId: string
  pageId: string
  name: string
  handle?: string
  avatarUrl?: string
  accessToken: string
}

interface FacebookPage {
  id?: string
  name?: string
  username?: string
  access_token?: string
  tasks?: string[]
  picture?: { data?: { url?: string } }
  instagram_business_account?: {
    id?: string
    name?: string
    username?: string
    profile_picture_url?: string
  }
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number }
  error_message?: string
  error_type?: string
}

export class MetaServiceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Messenger + Instagram 官方接入服务。
 *
 * - Facebook Messenger 使用 Facebook Login + Page Access Token。
 * - Instagram 使用 Instagram API with Instagram Login，不要求客户再绑定 Facebook Page。
 * - 所有平台令牌仅以 AES-256-GCM 密文落在服务器 SQLite，桌面端只拿账号摘要与消息事件。
 */
export class MetaService {
  private readonly db: Db
  private readonly config: ServerConfig
  private readonly fetchImpl: typeof fetch
  private readonly cipher: TokenCipher
  private readonly graphVersion: string
  private readonly mediaSigningKey: Buffer
  private readonly stagedMediaDir: string

  constructor(
    db: Db,
    config: ServerConfig,
    fetchImpl: typeof fetch = fetch
  ) {
    this.db = db
    this.config = config
    this.fetchImpl = fetchImpl
    this.graphVersion = config.metaGraphVersion || 'v26.0'
    const keyMaterial = config.metaTokenEncryptionKey || config.metaAppSecret || config.metaInstagramAppSecret
    this.cipher = new TokenCipher(keyMaterial)
    this.mediaSigningKey = createHash('sha256').update(keyMaterial || 'disabled').digest()
    this.stagedMediaDir = join(config.mediaDir, 'meta-outbound')
    mkdirSync(this.stagedMediaDir, { recursive: true })
  }

  available(channel: MetaChannel): boolean {
    if (!this.config.metaWebhookVerifyToken || !this.cipher.available) return false
    return channel === 'facebook'
      ? Boolean(this.config.metaAppId && this.config.metaAppSecret)
      : Boolean(this.config.metaInstagramAppId && this.config.metaInstagramAppSecret)
  }

  oauthRedirectUri(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/oauth/meta/callback`
  }

  webhookUrl(): string {
    return `${this.config.publicUrl.replace(/\/$/, '')}/webhook/meta`
  }

  beginOauth(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string
  ): { url: string; expiresAt: number } {
    this.assertAvailable(channel)
    assertAccountId(accountId)
    this.pruneOauth()
    this.db
      .delete(metaOauthStates)
      .where(and(
        eq(metaOauthStates.tenant, tenant),
        eq(metaOauthStates.ownerId, ownerId),
        eq(metaOauthStates.channel, channel),
        eq(metaOauthStates.accountId, accountId)
      ))
      .run()

    const state = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + OAUTH_TTL_MS
    this.db.insert(metaOauthStates).values({
      state,
      tenant,
      ownerId,
      channel,
      accountId,
      status: 'authorizing',
      data: '',
      expiresAt,
      createdAt: now
    }).run()

    const params = new URLSearchParams({
      client_id: channel === 'facebook'
        ? this.config.metaAppId!
        : this.config.metaInstagramAppId!,
      redirect_uri: this.oauthRedirectUri(),
      response_type: 'code',
      state,
      scope: channel === 'facebook'
        ? 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement'
        : 'instagram_business_basic,instagram_business_manage_messages'
    })
    if (channel === 'facebook' && this.config.metaLoginConfigId) {
      params.set('config_id', this.config.metaLoginConfigId)
      params.set('override_default_response_type', 'true')
    }
    const base = channel === 'facebook'
      ? `https://www.facebook.com/${this.graphVersion}/dialog/oauth`
      : 'https://www.instagram.com/oauth/authorize'
    return { url: `${base}?${params}`, expiresAt }
  }

  async oauthStatus(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string
  ): Promise<
    | { status: 'connected'; account: MetaAccountView }
    | { status: 'authorizing' | 'selecting' | 'error' | 'disconnected'; detail?: string }
  > {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, channel, accountId, true)
    if (account) return { status: 'connected', account: toAccountView(account) }
    const pending = this.db
      .select()
      .from(metaOauthStates)
      .where(and(
        eq(metaOauthStates.tenant, tenant),
        eq(metaOauthStates.ownerId, ownerId),
        eq(metaOauthStates.channel, channel),
        eq(metaOauthStates.accountId, accountId)
      ))
      .orderBy(desc(metaOauthStates.createdAt))
      .get()
    if (!pending || pending.expiresAt < Date.now()) {
      return {
        status: 'disconnected',
        detail: this.available(channel)
          ? '点击“授权并连接”，在浏览器中登录并选择要接入的账号。'
          : channel === 'facebook'
            ? '服务器尚未配置 Facebook Messenger 应用。'
            : '服务器尚未配置 Instagram 应用。'
      }
    }
    return {
      status: pending.status === 'selecting'
        ? 'selecting'
        : pending.status === 'error'
          ? 'error'
          : 'authorizing',
      detail: pending.error || (pending.status === 'selecting'
        ? '浏览器中有多个可用账号，请选择一个。'
        : '请在浏览器完成 Meta 授权；完成后这里会自动连接。')
    }
  }

  async completeOauth(state: string, code?: string, oauthError?: string): Promise<MetaOauthResult> {
    const pending = this.requireOauthState(state)
    if (oauthError) return this.failOauth(state, oauthError)
    if (!code) return this.failOauth(state, '授权回调缺少 code')
    try {
      if (pending.channel === 'instagram') {
        const resource = await this.exchangeInstagramCode(code)
        await this.connectResource(pending, resource)
        return { status: 'connected', message: `Instagram @${resource.handle || resource.name} 已连接` }
      }

      const userToken = await this.exchangeFacebookCode(code)
      const resources = await this.facebookPages(userToken)
      if (resources.length === 0) {
        return this.failOauth(state, '没有找到可管理且具备消息权限的 Facebook 主页。')
      }
      if (resources.length === 1) {
        await this.connectResource(pending, resources[0]!)
        return { status: 'connected', message: `Facebook 主页“${resources[0]!.name}”已连接` }
      }

      this.db.update(metaOauthStates).set({
        status: 'selecting',
        error: null,
        data: this.cipher.encrypt(JSON.stringify(resources))
      }).where(eq(metaOauthStates.state, state)).run()
      return {
        status: 'selecting',
        message: '请选择要接入的 Facebook 主页',
        resources: resources.map(publicResource)
      }
    } catch (error) {
      return this.failOauth(state, errorMessage(error))
    }
  }

  async selectOauthResource(state: string, resourceId: string): Promise<MetaOauthResult> {
    const pending = this.requireOauthState(state)
    if (pending.status !== 'selecting' || !pending.data) {
      return this.failOauth(state, '当前授权没有待选择的主页。')
    }
    try {
      const resources = JSON.parse(this.cipher.decrypt(pending.data)) as OauthResource[]
      const resource = resources.find((item) => item.id === resourceId)
      if (!resource) return this.failOauth(state, '所选主页不在本次授权范围内。')
      await this.connectResource(pending, resource)
      return { status: 'connected', message: `Facebook 主页“${resource.name}”已连接` }
    } catch (error) {
      return this.failOauth(state, errorMessage(error))
    }
  }

  disconnect(tenant: string, ownerId: number, channel: MetaChannel, accountId: string): void {
    assertAccountId(accountId)
    this.db.delete(metaAccounts).where(and(
      eq(metaAccounts.tenant, tenant),
      eq(metaAccounts.ownerId, ownerId),
      eq(metaAccounts.channel, channel),
      eq(metaAccounts.accountId, accountId)
    )).run()
    this.db.delete(metaEvents).where(and(
      eq(metaEvents.tenant, tenant),
      eq(metaEvents.ownerId, ownerId),
      eq(metaEvents.channel, channel),
      eq(metaEvents.accountId, accountId)
    )).run()
    this.db.delete(metaOauthStates).where(and(
      eq(metaOauthStates.tenant, tenant),
      eq(metaOauthStates.ownerId, ownerId),
      eq(metaOauthStates.channel, channel),
      eq(metaOauthStates.accountId, accountId)
    )).run()
  }

  /** 返回团队已授权的业务账号摘要；访问令牌始终不进入返回值。 */
  listAccounts(tenant: string, ownerId: number): MetaAccountView[] {
    return this.db.select().from(metaAccounts).where(and(
      eq(metaAccounts.tenant, tenant),
      eq(metaAccounts.ownerId, ownerId)
    )).orderBy(asc(metaAccounts.createdAt)).all().map(toAccountView)
  }

  verifyWebhookChallenge(mode: string | undefined, token: string | undefined): boolean {
    return mode === 'subscribe' && Boolean(token) && token === this.config.metaWebhookVerifyToken
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature?.startsWith('sha256=')) return false
    const suppliedHex = signature.slice('sha256='.length)
    if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false
    const supplied = Buffer.from(suppliedHex, 'hex')
    const secrets = [this.config.metaAppSecret, this.config.metaInstagramAppSecret]
      .filter((item): item is string => Boolean(item))
    return secrets.some((secret) => {
      const expected = createHmac('sha256', secret).update(rawBody).digest()
      return expected.length === supplied.length && timingSafeEqual(expected, supplied)
    })
  }

  enqueueWebhook(payload: unknown): number {
    const root = asRecord(payload)
    const object = stringValue(root?.object)
    if (object !== 'page' && object !== 'instagram') return 0
    let count = 0
    for (const entryValue of arrayValue(root?.entry)) {
      const entry = asRecord(entryValue)
      const entryId = stringValue(entry?.id)
      if (!entryId) continue
      const channel: MetaChannel = object === 'instagram' ? 'instagram' : 'facebook'
      const accounts = this.db.select().from(metaAccounts).where(and(
        eq(metaAccounts.channel, channel),
        eq(metaAccounts.assetId, entryId)
      )).all()
      if (accounts.length === 0) continue
      const events = [...arrayValue(entry?.messaging), ...arrayValue(entry?.standby)]
      for (const event of events) {
        const body = JSON.stringify({ object, entryId, event })
        for (const account of accounts) {
          this.db.insert(metaEvents).values({
            tenant: account.tenant,
            ownerId: account.ownerId,
            channel: account.channel,
            accountId: account.accountId,
            payload: body,
            createdAt: Date.now()
          }).run()
          count++
        }
      }
    }
    return count
  }

  pullEvents(tenant: string, ownerId: number, channel: MetaChannel, accountId: string): unknown[] {
    assertAccountId(accountId)
    const rows = this.db.select().from(metaEvents).where(and(
      eq(metaEvents.tenant, tenant),
      eq(metaEvents.ownerId, ownerId),
      eq(metaEvents.channel, channel),
      eq(metaEvents.accountId, accountId)
    )).orderBy(asc(metaEvents.id)).limit(500).all()
    if (rows.length > 0) {
      this.db.delete(metaEvents).where(inArray(metaEvents.id, rows.map((row) => row.id))).run()
    }
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload)]
      } catch {
        return []
      }
    })
  }

  prune(): { oauth: number; events: number; media: number } {
    const now = Date.now()
    const oauth = this.db.delete(metaOauthStates).where(lt(metaOauthStates.expiresAt, now)).run().changes
    const events = this.db.delete(metaEvents).where(lt(metaEvents.createdAt, now - EVENT_TTL_MS)).run().changes
    let media = 0
    try {
      for (const file of readdirSync(this.stagedMediaDir)) {
        if (!/^[a-f0-9]{48}\.[a-z0-9]{2,5}$/.test(file)) continue
        const path = join(this.stagedMediaDir, file)
        if (statSync(path).mtimeMs < now - STAGED_MEDIA_PRUNE_MS) {
          unlinkSync(path)
          media++
        }
      }
    } catch {
      // 目录暂时不可读时下个清理周期重试，不影响消息服务。
    }
    return { oauth, events, media }
  }

  async sendText(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string,
    recipientId: string,
    text: string
  ): Promise<{ messageId?: string; recipientId?: string }> {
    if (!recipientId || !text.trim()) throw new MetaServiceError('recipientId/text required')
    const account = await this.requireAccount(tenant, ownerId, channel, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message: { text }
    }
    if (channel === 'facebook') body.messaging_type = 'RESPONSE'
    const data = await this.graphJson<{ message_id?: string; recipient_id?: string }>(
      channel,
      `/${account.assetId}/messages`,
      token,
      { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    )
    return { messageId: data.message_id, recipientId: data.recipient_id }
  }

  /**
   * 将桌面端媒体暂存为一小时有效的不可猜签名 URL，再交给 Meta Send API 抓取。
   * 原始字节和临时 URL 都不会出现在接口响应中。
   */
  async sendMedia(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string,
    recipientId: string,
    mediaType: MetaOutboundMediaType,
    mimeType: string,
    dataBase64: string
  ): Promise<{ messageId?: string; recipientId?: string }> {
    if (!recipientId) throw new MetaServiceError('recipientId required')
    if (channel === 'instagram' && mediaType === 'document') {
      throw new MetaServiceError('Instagram 官方消息接口不支持发送普通文件。')
    }
    const account = await this.requireAccount(tenant, ownerId, channel, accountId)
    const bytes = decodeMediaBase64(dataBase64)
    const normalizedMime = normalizeOutboundMime(mediaType, mimeType)
    const extension = extensionForMime(normalizedMime)
    const file = `${randomBytes(24).toString('hex')}.${extension}`
    const path = join(this.stagedMediaDir, file)
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })

    const expiresAt = Date.now() + STAGED_MEDIA_TTL_MS
    const signature = this.mediaSignature(file, expiresAt)
    const mediaUrl = `${this.config.publicUrl.replace(/\/$/, '')}/meta-media/${file}` +
      `?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`
    const attachmentType = mediaType === 'document'
      ? 'file'
      : mediaType === 'sticker'
        ? 'image'
        : mediaType
    const token = this.cipher.decrypt(account.accessToken)
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: attachmentType,
          payload: { url: mediaUrl }
        }
      }
    }
    if (channel === 'facebook') body.messaging_type = 'RESPONSE'
    const data = await this.graphJson<{ message_id?: string; recipient_id?: string }>(
      channel,
      `/${account.assetId}/messages`,
      token,
      { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    )
    return { messageId: data.message_id, recipientId: data.recipient_id }
  }

  /** 校验公开临时媒体 URL，供 Fastify 路由流式返回文件。 */
  resolveStagedMedia(
    file: string,
    expiresText: string | undefined,
    signature: string | undefined
  ): { path: string; mimeType: string } | undefined {
    if (!this.cipher.available || !/^[a-f0-9]{48}\.[a-z0-9]{2,5}$/.test(file)) return undefined
    const expiresAt = Number(expiresText)
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !signature) return undefined
    const expected = Buffer.from(this.mediaSignature(file, expiresAt))
    const supplied = Buffer.from(signature)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined
    const mimeType = mimeForExtension(file.slice(file.lastIndexOf('.') + 1))
    if (!mimeType) return undefined
    const path = join(this.stagedMediaDir, file)
    try {
      if (!statSync(path).isFile()) return undefined
    } catch {
      return undefined
    }
    return { path, mimeType }
  }

  async profile(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string,
    userId: string
  ): Promise<MetaProfile> {
    if (!userId) throw new MetaServiceError('userId required')
    const account = await this.requireAccount(tenant, ownerId, channel, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const data = await this.graphJson<Record<string, unknown>>(
      channel,
      `/${encodeURIComponent(userId)}?fields=${channel === 'facebook'
        ? 'id,name,first_name,last_name,profile_pic'
        : 'id,name,username,profile_pic'}`,
      token
    )
    const first = stringValue(data.first_name)
    const last = stringValue(data.last_name)
    return {
      id: stringValue(data.id) || userId,
      name: stringValue(data.name) || [first, last].filter(Boolean).join(' ') || undefined,
      username: stringValue(data.username) || undefined,
      avatarUrl: stringValue(data.profile_pic) || undefined
    }
  }

  async history(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string
  ): Promise<MetaHistoryConversation[]> {
    const account = await this.requireAccount(tenant, ownerId, channel, accountId)
    const token = this.cipher.decrypt(account.accessToken)
    const fields = 'id,updated_time,participants,messages.limit(25){id,created_time,from,to,message,attachments}'
    const platform = channel === 'instagram' ? '&platform=instagram' : ''
    const response = await this.graphJson<{ data?: unknown[] }>(
      channel,
      `/${account.assetId}/conversations?fields=${encodeURIComponent(fields)}&limit=50${platform}`,
      token
    )
    return arrayValue(response.data)
      .map((value) => normalizeHistoryConversation(value, account.assetId, account.pageId))
      .filter((value): value is MetaHistoryConversation => Boolean(value))
  }

  private assertAvailable(channel: MetaChannel): void {
    if (!this.available(channel)) {
      throw new MetaServiceError(
        channel === 'facebook'
          ? '服务器尚未配置 META_APP_ID / META_APP_SECRET / Webhook 校验串。'
          : '服务器尚未配置 META_INSTAGRAM_APP_ID / META_INSTAGRAM_APP_SECRET / Webhook 校验串。',
        503
      )
    }
  }

  private mediaSignature(file: string, expiresAt: number): string {
    return createHmac('sha256', this.mediaSigningKey)
      .update(`${file}\n${expiresAt}`)
      .digest('base64url')
  }

  private requireOauthState(state: string) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) throw new MetaServiceError('非法 OAuth state')
    const pending = this.db.select().from(metaOauthStates).where(eq(metaOauthStates.state, state)).get()
    if (!pending || pending.expiresAt < Date.now()) throw new MetaServiceError('授权已过期，请回到客户端重新发起。', 410)
    return pending
  }

  private failOauth(state: string, message: string): MetaOauthResult {
    this.db.update(metaOauthStates).set({ status: 'error', error: message.slice(0, 500) })
      .where(eq(metaOauthStates.state, state)).run()
    return { status: 'error', message }
  }

  private async exchangeFacebookCode(code: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.config.metaAppId!,
      client_secret: this.config.metaAppSecret!,
      redirect_uri: this.oauthRedirectUri(),
      code
    })
    const short = await this.requestJson<{ access_token?: string }>(
      `https://graph.facebook.com/${this.graphVersion}/oauth/access_token?${params}`
    )
    if (!short.access_token) throw new MetaServiceError('Meta 没有返回访问令牌。', 502)
    try {
      const longParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.config.metaAppId!,
        client_secret: this.config.metaAppSecret!,
        fb_exchange_token: short.access_token
      })
      const long = await this.requestJson<{ access_token?: string }>(
        `https://graph.facebook.com/${this.graphVersion}/oauth/access_token?${longParams}`
      )
      return long.access_token || short.access_token
    } catch {
      return short.access_token
    }
  }

  private async exchangeInstagramCode(code: string): Promise<OauthResource> {
    const form = new FormData()
    form.set('client_id', this.config.metaInstagramAppId!)
    form.set('client_secret', this.config.metaInstagramAppSecret!)
    form.set('grant_type', 'authorization_code')
    form.set('redirect_uri', this.oauthRedirectUri())
    form.set('code', code)
    const short = await this.requestJson<{ access_token?: string; user_id?: string | number }>(
      'https://api.instagram.com/oauth/access_token',
      { method: 'POST', body: form }
    )
    if (!short.access_token) throw new MetaServiceError('Instagram 没有返回访问令牌。', 502)
    let token = short.access_token
    try {
      const params = new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: this.config.metaInstagramAppSecret!,
        access_token: short.access_token
      })
      const long = await this.requestJson<{ access_token?: string }>(
        `https://graph.instagram.com/access_token?${params}`
      )
      token = long.access_token || token
    } catch {
      // 短令牌仍可完成首次连接；后续状态会明确报告失效，不把一次换长失败伪装成登录失败。
    }
    const me = await this.graphJson<Record<string, unknown>>(
      'instagram',
      '/me?fields=id,user_id,username,name,profile_picture_url',
      token
    )
    const assetId = stringValue(me.user_id) || stringValue(me.id) || String(short.user_id || '')
    if (!assetId) throw new MetaServiceError('无法读取 Instagram 专业账号 ID。', 502)
    const username = stringValue(me.username)
    return {
      id: assetId,
      assetId,
      pageId: assetId,
      name: stringValue(me.name) || username || 'Instagram',
      handle: username || undefined,
      avatarUrl: stringValue(me.profile_picture_url) || undefined,
      accessToken: token
    }
  }

  private async facebookPages(userToken: string): Promise<OauthResource[]> {
    const fields = 'id,name,username,access_token,tasks,picture.type(large){url}'
    const first = `https://graph.facebook.com/${this.graphVersion}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100`
    const pages: FacebookPage[] = []
    let next: string | undefined = first
    for (let page = 0; next && page < 20; page++) {
      const parsed = new URL(next)
      if (parsed.hostname !== 'graph.facebook.com') throw new MetaServiceError('Meta 分页地址非法。', 502)
      const result: { data?: FacebookPage[]; paging?: { next?: string } } =
        await this.requestJson(next, {
        headers: { authorization: `Bearer ${userToken}` }
      })
      pages.push(...(result.data ?? []))
      next = result.paging?.next
    }
    return pages.flatMap((page) => {
      if (!page.id || !page.access_token) return []
      if (page.tasks?.length && !page.tasks.some((task) => task === 'MESSAGING' || task === 'MODERATE')) return []
      return [{
        id: page.id,
        assetId: page.id,
        pageId: page.id,
        name: page.name || page.username || `Page ${page.id}`,
        handle: page.username || undefined,
        avatarUrl: page.picture?.data?.url,
        accessToken: page.access_token
      }]
    })
  }

  private async connectResource(
    pending: typeof metaOauthStates.$inferSelect,
    resource: OauthResource
  ): Promise<void> {
    const channel = pending.channel as MetaChannel
    await this.subscribe(channel, resource)
    const now = Date.now()
    this.db.insert(metaAccounts).values({
      tenant: pending.tenant,
      ownerId: pending.ownerId,
      channel,
      accountId: pending.accountId,
      assetId: resource.assetId,
      pageId: resource.pageId,
      displayName: resource.name,
      handle: resource.handle ?? null,
      avatarUrl: resource.avatarUrl ?? null,
      accessToken: this.cipher.encrypt(resource.accessToken),
      createdAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [metaAccounts.tenant, metaAccounts.ownerId, metaAccounts.channel, metaAccounts.accountId],
      set: {
        assetId: resource.assetId,
        pageId: resource.pageId,
        displayName: resource.name,
        handle: resource.handle ?? null,
        avatarUrl: resource.avatarUrl ?? null,
        accessToken: this.cipher.encrypt(resource.accessToken),
        updatedAt: now
      }
    }).run()
    this.db.delete(metaOauthStates).where(eq(metaOauthStates.state, pending.state)).run()
  }

  private async subscribe(channel: MetaChannel, resource: OauthResource): Promise<void> {
    if (channel === 'instagram') {
      await this.graphJson(
        channel,
        `/${resource.assetId}/subscribed_apps`,
        resource.accessToken,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: [
              'messages',
              'messaging_postbacks',
              'messaging_seen',
              'messaging_referral',
              'message_reactions'
            ]
          })
        }
      )
      return
    }
    await this.graphJson(
      channel,
      `/${resource.pageId}/subscribed_apps?subscribed_fields=messages,message_echoes,messaging_postbacks,message_deliveries,message_reads,messaging_referrals`,
      resource.accessToken,
      { method: 'POST' }
    )
  }

  private async requireAccount(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string
  ) {
    assertAccountId(accountId)
    const account = await this.loadAccount(tenant, ownerId, channel, accountId, true)
    if (!account) throw new MetaServiceError('Meta 账号尚未授权或已退出。', 404)
    return account
  }

  private async loadAccount(
    tenant: string,
    ownerId: number,
    channel: MetaChannel,
    accountId: string,
    refreshInstagram: boolean
  ) {
    let account = this.db.select().from(metaAccounts).where(and(
      eq(metaAccounts.tenant, tenant),
      eq(metaAccounts.ownerId, ownerId),
      eq(metaAccounts.channel, channel),
      eq(metaAccounts.accountId, accountId)
    )).get()
    if (
      account && refreshInstagram && channel === 'instagram' &&
      account.updatedAt < Date.now() - IG_REFRESH_AFTER_MS
    ) {
      try {
        const current = this.cipher.decrypt(account.accessToken)
        const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: current })
        const refreshed = await this.requestJson<{ access_token?: string }>(
          `https://graph.instagram.com/refresh_access_token?${params}`
        )
        if (refreshed.access_token) {
          const updatedAt = Date.now()
          this.db.update(metaAccounts).set({
            accessToken: this.cipher.encrypt(refreshed.access_token),
            updatedAt
          }).where(and(
            eq(metaAccounts.tenant, tenant),
            eq(metaAccounts.ownerId, ownerId),
            eq(metaAccounts.channel, channel),
            eq(metaAccounts.accountId, accountId)
          )).run()
          account = { ...account, accessToken: this.cipher.encrypt(refreshed.access_token), updatedAt }
        }
      } catch {
        // 临时网络错误不应把一个仍可能有效的账号踢下线，实际 Graph 调用会给出最终结果。
      }
    }
    return account
  }

  private async graphJson<T>(
    channel: MetaChannel,
    path: string,
    accessToken: string,
    init: RequestInit = {}
  ): Promise<T> {
    const host = channel === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'
    const normalized = path.startsWith('/') ? path : `/${path}`
    return this.requestJson<T>(`https://${host}/${this.graphVersion}${normalized}`, {
      ...init,
      headers: { ...headersObject(init.headers), authorization: `Bearer ${accessToken}` }
    })
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new MetaServiceError(`连接 Meta 失败：${errorMessage(error)}`, 502)
    }
    const text = await response.text()
    let data: T & GraphErrorBody
    try {
      data = (text ? JSON.parse(text) : {}) as T & GraphErrorBody
    } catch {
      throw new MetaServiceError(`Meta 返回了无法解析的数据（HTTP ${response.status}）。`, 502)
    }
    if (!response.ok || data.error || data.error_message) {
      const message = data.error?.message || data.error_message || `HTTP ${response.status}`
      throw new MetaServiceError(`Meta API：${message}`, response.status >= 500 ? 502 : 400)
    }
    return data
  }

  private pruneOauth(): void {
    this.db.delete(metaOauthStates).where(lt(metaOauthStates.expiresAt, Date.now())).run()
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
    if (!this.available) throw new MetaServiceError('Meta 令牌加密密钥未配置或不足 32 位。', 503)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
  }

  decrypt(value: string): string {
    if (!this.available) throw new MetaServiceError('Meta 令牌加密密钥未配置。', 503)
    const [version, ivText, tagText, encryptedText] = value.split(':')
    if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
      throw new MetaServiceError('Meta 令牌密文损坏，请重新授权。', 500)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final()
      ]).toString('utf8')
    } catch {
      throw new MetaServiceError('Meta 令牌无法解密，请重新授权。', 500)
    }
  }
}

function normalizeHistoryConversation(
  value: unknown,
  assetId: string,
  pageId: string
): MetaHistoryConversation | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  const participantsRoot = asRecord(raw.participants)
  const participants = arrayValue(participantsRoot?.data).map(asRecord).filter(Boolean)
  const selfIds = new Set([assetId, pageId])
  const peer = participants.find((participant) => {
    const id = stringValue(participant?.id)
    return id && !selfIds.has(id)
  })
  const messagesRoot = asRecord(raw.messages)
  const messages = arrayValue(messagesRoot?.data)
    .map(normalizeHistoryMessage)
    .filter((message): message is MetaHistoryMessage => Boolean(message))
    .sort((a, b) => a.createdTime - b.createdTime)
  const derivedPeerId = messages.flatMap((message) => [message.fromId, ...message.toIds])
    .find((id) => id && !selfIds.has(id))
  const externalChatId = stringValue(peer?.id) || derivedPeerId
  if (!externalChatId) return undefined
  const updated = Date.parse(stringValue(raw.updated_time) || '')
  return {
    externalChatId,
    title: stringValue(peer?.name) || externalChatId,
    updatedTime: Number.isFinite(updated) ? updated : messages.at(-1)?.createdTime || 0,
    messages
  }
}

function normalizeHistoryMessage(value: unknown): MetaHistoryMessage | undefined {
  const raw = asRecord(value)
  const id = stringValue(raw?.id)
  if (!raw || !id) return undefined
  const from = asRecord(raw.from)
  const to = asRecord(raw.to)
  const created = Date.parse(stringValue(raw.created_time) || '')
  const attachmentsRoot = asRecord(raw.attachments)
  return {
    id,
    createdTime: Number.isFinite(created) ? created : Date.now(),
    fromId: stringValue(from?.id) || undefined,
    fromName: stringValue(from?.name) || undefined,
    toIds: arrayValue(to?.data).map(asRecord).map((item) => stringValue(item?.id)).filter(Boolean),
    text: stringValue(raw.message) || undefined,
    attachments: arrayValue(attachmentsRoot?.data).map(normalizeHistoryAttachment)
  }
}

function normalizeHistoryAttachment(value: unknown): MetaHistoryAttachment {
  const raw = asRecord(value) ?? {}
  const image = asRecord(raw.image_data)
  const video = asRecord(raw.video_data)
  const file = asRecord(raw.file_data)
  return {
    type: stringValue(raw.mime_type)?.split('/')[0] || stringValue(raw.type) || 'file',
    url: stringValue(image?.url) || stringValue(video?.url) || stringValue(file?.url) ||
      stringValue(raw.file_url) || stringValue(raw.url) || undefined,
    name: stringValue(raw.name) || stringValue(file?.name) || undefined,
    mimeType: stringValue(raw.mime_type) || undefined
  }
}

function publicResource(resource: OauthResource) {
  return {
    id: resource.id,
    name: resource.name,
    handle: resource.handle,
    avatarUrl: resource.avatarUrl
  }
}

function toAccountView(account: typeof metaAccounts.$inferSelect): MetaAccountView {
  return {
    channel: account.channel as MetaChannel,
    accountId: account.accountId,
    assetId: account.assetId,
    pageId: account.pageId,
    displayName: account.displayName,
    handle: account.handle ?? undefined,
    avatarUrl: account.avatarUrl ?? undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function headersObject(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(new Headers(headers).entries())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
}

function normalizeOutboundMime(mediaType: MetaOutboundMediaType, raw: string): string {
  const mime = raw.toLowerCase().split(';', 1)[0]?.trim() || ''
  const extension = MIME_EXTENSION[mime]
  if (!extension) throw new MetaServiceError(`Meta 暂不支持此文件格式：${raw || 'unknown'}`)
  const expected = mediaType === 'sticker' ? 'image' : mediaType === 'document' ? undefined : mediaType
  if (expected && !mime.startsWith(`${expected}/`)) {
    throw new MetaServiceError(`媒体类型与 MIME 不一致：${mediaType} / ${mime}`)
  }
  return mime
}

function extensionForMime(mime: string): string {
  return MIME_EXTENSION[mime]!
}

function mimeForExtension(extension: string): string | undefined {
  return Object.entries(MIME_EXTENSION).find(([, ext]) => ext === extension)?.[0]
}

function decodeMediaBase64(value: string): Buffer {
  if (!value || value.length > Math.ceil(MAX_OUTBOUND_MEDIA_BYTES * 4 / 3) + 4) {
    throw new MetaServiceError(`媒体不能为空且不能超过 ${MAX_OUTBOUND_MEDIA_BYTES / 1024 / 1024} MB`, 413)
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new MetaServiceError('媒体 Base64 数据无效。')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new MetaServiceError(`媒体不能为空且不能超过 ${MAX_OUTBOUND_MEDIA_BYTES / 1024 / 1024} MB`, 413)
  }
  return bytes
}

function assertAccountId(value: string): void {
  if (!ACCOUNT_ID_RE.test(value)) throw new MetaServiceError('非法 accountId')
}

export function isMetaChannel(value: unknown): value is MetaChannel {
  return value === 'facebook' || value === 'instagram'
}
