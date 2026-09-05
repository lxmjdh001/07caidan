import type { Dispatcher } from 'undici'
import { readFile } from 'node:fs/promises'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { extFromMime } from '../../core/mime'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, withDispatcher } from '../../core/proxy'
import {
  mapTikTokHistoryMessage,
  mapTikTokWebhook,
  type TikTokAccountSummary,
  type TikTokMediaReference,
  type TikTokMessageInput,
  type TikTokWebhookEnvelope
} from './mapper'

interface TikTokAccount extends TikTokAccountSummary {
  channel: 'tiktok'
  accountId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

interface TikTokStatusResponse {
  status: 'connected' | 'authorizing' | 'error' | 'disconnected'
  detail?: string
  account?: TikTokAccount
}

interface TikTokProfile {
  id: string
  name?: string
  username?: string
  avatarUrl?: string
  contactId?: string
}

interface TikTokHistoryResponse {
  conversations?: Array<{
    externalChatId: string
    title: string
    publicId?: string
    contactId?: string
    avatarUrl?: string
    updatedTime: number
    messages: TikTokMessageInput[]
  }>
}

export interface TikTokAdapterOptions {
  accountId: string
  logger?: Logger
  getBackend: () => { url?: string; token?: string }
  openExternal: (url: string) => Promise<void>
  getProxyUrl?: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const EVENT_POLL_MS = 3_000
const OAUTH_POLL_MS = 2_000
const HISTORY_REFRESH_MIN_MS = 15_000
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_OUTBOUND_IMAGE_BYTES = 3 * 1024 * 1024

/** 桌面薄适配器：TikTok OAuth、令牌刷新、Webhook 与 Business API 全部由服务器承载。 */
export class TikTokAdapter extends ChannelAdapter {
  readonly kind = 'tiktok' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly getBackend: () => { url?: string; token?: string }
  private readonly openExternal: (url: string) => Promise<void>
  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>
  private status: ChannelStatus = 'stopped'
  private account: TikTokAccount | undefined
  private eventTimer: ReturnType<typeof setInterval> | undefined
  private oauthTimer: ReturnType<typeof setInterval> | undefined
  private starting: Promise<void> | undefined
  private pollingEvents = false
  private pollingOauth = false
  private historyBusinessId: string | undefined
  private historyPromise: Promise<void> | undefined
  private historyRefreshedAt = 0
  private dispatcher: Dispatcher | undefined
  private readonly profiles = new Map<string, TikTokProfile>()

  constructor(options: TikTokAdapterOptions) {
    super()
    this.accountId = options.accountId
    this.log = (options.logger ?? noopLogger).child(`tiktok:${options.accountId}`)
    this.getBackend = options.getBackend
    this.openExternal = options.openExternal
    this.getProxyUrl = options.getProxyUrl ?? (() => undefined)
    this.saveMedia = options.saveMedia
  }

  async start(): Promise<void> {
    if (this.starting || this.eventTimer) return
    await this.resetDispatcher()
    this.starting = this.connectExisting().finally(() => { this.starting = undefined })
    await this.starting
  }

  override async beginOAuth(): Promise<void> {
    this.requireBackend()
    await this.resetDispatcher()
    this.clearOauthTimer()
    this.setState('connecting', { detail: '正在创建 TikTok 安全授权链接…' })
    try {
      const response = await this.api<{ url?: string }>('/api/tiktok/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: this.accountId })
      })
      if (!response.url || new URL(response.url).hostname !== 'ads.tiktok.com') {
        throw new Error('服务器返回的 TikTok 授权地址无效')
      }
      await this.openExternal(response.url)
      this.setState('waiting_oauth', {
        detail: '请在浏览器登录 TikTok 企业号，并允许 OmniChat 读取和回复私信。'
      })
      this.oauthTimer = setInterval(() => void this.pollOauth(), OAUTH_POLL_MS)
      this.oauthTimer.unref?.()
    } catch (error) {
      this.setState('error', { detail: errorMessage(error) })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.clearTimers()
    await this.closeDispatcher()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    this.clearTimers()
    try {
      const query = new URLSearchParams({ accountId: this.accountId })
      await this.api(`/api/tiktok/account?${query}`, { method: 'DELETE' })
    } catch (error) {
      this.log.warn('服务端 TikTok 账号解绑失败', { error: errorMessage(error) })
    }
    this.account = undefined
    this.profiles.clear()
    this.historyBusinessId = undefined
    await this.closeDispatcher()
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    this.assertConnected()
    const result = await this.api<{ messageId?: string }>('/api/tiktok/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, conversationId: externalChatId, text })
    })
    return { externalId: result.messageId }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    this.assertConnected()
    if (media.mediaType !== 'image') {
      throw new Error('TikTok 官方私信接口目前只支持发送 JPG / PNG 图片。')
    }
    const mimeType = media.mimeType.split(';', 1)[0]?.toLowerCase()
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
      throw new Error('TikTok 官方私信接口仅支持 JPG 或 PNG 图片。')
    }
    if (media.caption?.trim()) {
      throw new Error('TikTok 图片消息不能同时带说明文字，请将文字另发一条。')
    }
    const data = await readFile(media.filePath)
    if (data.length === 0 || data.length > MAX_OUTBOUND_IMAGE_BYTES) {
      throw new Error('TikTok 图片不能为空且不能超过 3 MB。')
    }
    const result = await this.api<{ messageId?: string }>('/api/tiktok/send-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: this.accountId,
        conversationId: externalChatId,
        mediaType: 'image',
        mimeType,
        dataBase64: data.toString('base64')
      })
    })
    return { externalId: result.messageId }
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    return (await this.profile(externalChatId))?.name
  }

  override async fetchPublicId(externalChatId: string): Promise<string | undefined> {
    const username = (await this.profile(externalChatId))?.username
    return username ? `@${username.replace(/^@/, '')}` : undefined
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    const account = this.account
    if (!account) return undefined
    const profile = await this.profile(externalChatId)
    return profile?.contactId || (profile?.id ? `tiktok:${account.businessId}:${profile.id}` : undefined)
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    const url = (await this.profile(externalChatId))?.avatarUrl
    return url ? this.downloadUrl(url) : undefined
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    return this.account?.avatarUrl ? this.downloadUrl(this.account.avatarUrl) : undefined
  }

  private async connectExisting(): Promise<void> {
    try {
      this.requireBackend()
      this.setState('connecting', { detail: '正在检查 TikTok 授权…' })
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) {
        await this.onConnected(status.account)
      } else if (status.status === 'authorizing') {
        this.setState('waiting_oauth', { detail: status.detail })
        this.oauthTimer = setInterval(() => void this.pollOauth(), OAUTH_POLL_MS)
        this.oauthTimer.unref?.()
      } else if (status.status === 'error') {
        this.setState('error', { detail: status.detail })
      } else {
        this.setState('need_credentials', { detail: status.detail })
      }
    } catch (error) {
      this.setState('error', { detail: errorMessage(error) })
    }
  }

  private async pollOauth(): Promise<void> {
    if (this.pollingOauth) return
    this.pollingOauth = true
    try {
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) {
        this.clearOauthTimer()
        await this.onConnected(status.account)
      } else if (status.status === 'error') {
        this.clearOauthTimer()
        this.setState('error', { detail: status.detail })
      } else if (status.status === 'disconnected') {
        this.clearOauthTimer()
        this.setState('need_credentials', { detail: status.detail })
      } else {
        this.setState('waiting_oauth', { detail: status.detail })
      }
    } catch (error) {
      this.log.debug('TikTok 授权状态轮询失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingOauth = false
    }
  }

  private async onConnected(account: TikTokAccount): Promise<void> {
    this.account = account
    this.profiles.clear()
    this.requiredDispatcher()
    this.setState('connected', {
      selfName: account.displayName,
      selfHandle: account.handle ? `@${account.handle.replace(/^@/, '')}` : undefined
    })
    if (!this.eventTimer) {
      this.eventTimer = setInterval(() => void this.pollEvents(), EVENT_POLL_MS)
      this.eventTimer.unref?.()
    }
    void this.pollEvents()
    if (this.historyBusinessId !== account.businessId) {
      this.historyBusinessId = account.businessId
      void this.hydrateHistory(true)
    }
  }

  private hydrateHistory(force = false): Promise<void> {
    if (this.historyPromise) return this.historyPromise
    if (!force && Date.now() - this.historyRefreshedAt < HISTORY_REFRESH_MIN_MS) return Promise.resolve()
    this.historyPromise = this.loadHistory().finally(() => { this.historyPromise = undefined })
    return this.historyPromise
  }

  private async loadHistory(): Promise<void> {
    const account = this.account
    if (!account) return
    try {
      const query = new URLSearchParams({ accountId: this.accountId })
      const response = await this.api<TikTokHistoryResponse>(`/api/tiktok/history?${query}`)
      this.historyRefreshedAt = Date.now()
      for (const conversation of response.conversations ?? []) {
        this.profiles.set(conversation.externalChatId, {
          id: contactTail(conversation.contactId) || conversation.externalChatId,
          name: conversation.title,
          username: conversation.publicId?.replace(/^@/, ''),
          avatarUrl: conversation.avatarUrl,
          contactId: conversation.contactId
        })
        this.emit('conversation', {
          externalChatId: conversation.externalChatId,
          title: conversation.title,
          publicId: conversation.publicId,
          contactId: conversation.contactId,
          isGroup: false,
          lastMessageAt: conversation.updatedTime,
          lastMessagePreview: previewFor(conversation.messages.at(-1))
        })
        for (const raw of conversation.messages) {
          const mapped = mapTikTokHistoryMessage(
            raw,
            this.accountId,
            conversation.externalChatId,
            account
          )
          this.emit('historyMessage', await this.attachMedia(mapped.message, mapped.media))
        }
      }
    } catch (error) {
      this.log.warn('TikTok 历史会话读取失败，新 Webhook 消息仍会继续接收', {
        error: errorMessage(error)
      })
    }
  }

  private async pollEvents(): Promise<void> {
    if (this.pollingEvents || !this.account || this.status !== 'connected') return
    this.pollingEvents = true
    try {
      const query = new URLSearchParams({ accountId: this.accountId })
      const response = await this.api<{ events?: TikTokWebhookEnvelope[] }>(`/api/tiktok/events?${query}`)
      for (const envelope of response.events ?? []) {
        const mapped = mapTikTokWebhook(envelope, this.accountId, this.account)
        if (!mapped) continue
        if ('needsHistoryRefresh' in mapped) {
          void this.hydrateHistory()
          continue
        }
        if (mapped.profile) {
          const existing = this.profiles.get(mapped.conversation.externalChatId)
          this.profiles.set(mapped.conversation.externalChatId, {
            id: contactTail(mapped.profile.contactId) || existing?.id || mapped.conversation.externalChatId,
            name: mapped.profile.name || existing?.name,
            username: mapped.profile.username || existing?.username,
            avatarUrl: existing?.avatarUrl,
            contactId: mapped.profile.contactId || existing?.contactId
          })
        }
        this.emit('conversation', mapped.conversation)
        this.emit('message', await this.attachMedia(mapped.message, mapped.media))
      }
    } catch (error) {
      this.log.debug('TikTok 事件拉取失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingEvents = false
    }
  }

  private async attachMedia(
    message: UnifiedMessage,
    reference: TikTokMediaReference | undefined
  ): Promise<UnifiedMessage> {
    if (!reference || message.body.type !== 'media' || !this.saveMedia) return message
    const mediaId = reference.kind === 'api'
      ? await this.downloadApiMedia(reference)
      : await this.downloadUrl(reference.url, message.body.mimeType)
    return mediaId ? { ...message, body: { ...message.body, mediaId } } : message
  }

  private async downloadApiMedia(reference: Extract<TikTokMediaReference, { kind: 'api' }>): Promise<string | undefined> {
    if (!this.saveMedia) return undefined
    const query = new URLSearchParams({
      accountId: this.accountId,
      conversationId: reference.conversationId,
      messageId: reference.messageId,
      mediaId: reference.mediaId,
      mediaType: reference.mediaType
    })
    try {
      const response = await this.rawApi(`/api/tiktok/media?${query}`)
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return undefined
      const mimeType = response.headers.get('content-type') ||
        (reference.mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg')
      return await this.saveMedia(data, extFromMime(mimeType))
    } catch (error) {
      this.log.debug('TikTok 媒体下载失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private async downloadUrl(url: string, hintedMime?: string): Promise<string | undefined> {
    if (!this.saveMedia || !safeTikTokMediaUrl(url)) return undefined
    try {
      const response = await fetch(url, withDispatcher({ signal: AbortSignal.timeout(30_000) }, this.requiredDispatcher()))
      if (!response.ok) return undefined
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > MAX_MEDIA_BYTES) return undefined
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return undefined
      return await this.saveMedia(data, extFromMime(response.headers.get('content-type') || hintedMime))
    } catch (error) {
      this.log.debug('TikTok 头像/贴纸下载失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private async profile(externalChatId: string): Promise<TikTokProfile | undefined> {
    const cached = this.profiles.get(externalChatId)
    if (cached) return cached
    const query = new URLSearchParams({ accountId: this.accountId, conversationId: externalChatId })
    try {
      const response = await this.api<{ profile?: TikTokProfile }>(`/api/tiktok/profile?${query}`)
      if (response.profile) {
        const contactId = this.account && response.profile.id
          ? `tiktok:${this.account.businessId}:${response.profile.id}`
          : undefined
        const profile = { ...response.profile, contactId }
        this.profiles.set(externalChatId, profile)
        return profile
      }
    } catch (error) {
      this.log.debug('TikTok 客户资料读取失败', { externalChatId, error: errorMessage(error) })
    }
    return undefined
  }

  private fetchStatus(): Promise<TikTokStatusResponse> {
    const query = new URLSearchParams({ accountId: this.accountId })
    return this.api<TikTokStatusResponse>(`/api/tiktok/account?${query}`)
  }

  private assertConnected(): void {
    if (!this.account || this.status !== 'connected') throw new Error('TikTok 账号尚未连接')
  }

  private requireBackend(): { base: string; token: string } {
    const backend = this.getBackend()
    const base = backend.url?.replace(/\/$/, '')
    const token = backend.token?.trim()
    if (!base || !token) throw new Error('请先登录 OmniChat 后台，再授权 TikTok 企业号。')
    return { base, token }
  }

  private async rawApi(path: string, init: RequestInit = {}): Promise<Response> {
    const { base, token } = this.requireBackend()
    const response = await fetch(
      `${base}${path}`,
      withDispatcher({
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${token}`
        },
        signal: init.signal ?? AbortSignal.timeout(30_000)
      }, this.requiredDispatcher())
    )
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(data.error || `OmniChat 后台 HTTP ${response.status}`)
    }
    return response
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.rawApi(path, init)
    const raw = await response.text()
    try {
      return (raw ? JSON.parse(raw) : {}) as T
    } catch {
      throw new Error(`OmniChat 后台返回了无法解析的数据（HTTP ${response.status}）`)
    }
  }

  private clearOauthTimer(): void {
    if (this.oauthTimer) clearInterval(this.oauthTimer)
    this.oauthTimer = undefined
  }

  private clearTimers(): void {
    this.clearOauthTimer()
    if (this.eventTimer) clearInterval(this.eventTimer)
    this.eventTimer = undefined
  }

  private requiredDispatcher(): Dispatcher {
    if (!this.dispatcher) throw new Error('代理链路已断开，安全隔离已阻止直连')
    return this.dispatcher
  }

  private async resetDispatcher(): Promise<void> {
    await this.closeDispatcher()
    this.dispatcher = createRequiredDispatcher(this.getProxyUrl())
  }

  private async closeDispatcher(): Promise<void> {
    const dispatcher = this.dispatcher
    this.dispatcher = undefined
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; selfName?: string; selfHandle?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function previewFor(message: TikTokMessageInput | undefined): string | undefined {
  if (!message) return undefined
  if (message.text?.body) return message.text.body
  switch (String(message.message_type || message.type || '').toUpperCase()) {
    case 'IMAGE': return '[图片]'
    case 'VIDEO': return '[视频]'
    case 'STICKER': return '[贴纸]'
    case 'EMOJI': return '[表情]'
    case 'SHARE_POST': return '[TikTok 帖子]'
    default: return undefined
  }
}

function contactTail(contactId: string | undefined): string | undefined {
  if (!contactId) return undefined
  const index = contactId.lastIndexOf(':')
  return index >= 0 ? contactId.slice(index + 1) : contactId
}

function safeTikTokMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return [
      '.tiktokcdn.com',
      '.tiktokcdn-us.com',
      '.byteoversea.com',
      '.ibytedtos.com',
      '.muscdn.com',
      '.tiktok.com'
    ].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
