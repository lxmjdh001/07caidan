import type { Dispatcher } from 'undici'
import { readFile } from 'node:fs/promises'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { extFromMime } from '../../core/mime'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, withDispatcher } from '../../core/proxy'
import {
  mapMetaHistoryMessage,
  mapMetaWebhook,
  type MetaAccountSummary,
  type MetaChannel,
  type MetaHistoryMessageInput,
  type MetaWebhookEnvelope
} from './mapper'

interface MetaAccount extends MetaAccountSummary {
  channel: MetaChannel
  accountId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

interface MetaStatusResponse {
  status: 'connected' | 'authorizing' | 'selecting' | 'error' | 'disconnected'
  detail?: string
  account?: MetaAccount
}

interface MetaProfileResponse {
  profile?: { id: string; name?: string; username?: string; avatarUrl?: string }
}

interface MetaHistoryResponse {
  conversations?: Array<{
    externalChatId: string
    title: string
    updatedTime: number
    messages: MetaHistoryMessageInput[]
  }>
}

export interface MetaAdapterOptions {
  channel: MetaChannel
  accountId: string
  logger?: Logger
  getBackend: () => { url?: string; token?: string }
  openExternal: (url: string) => Promise<void>
  getProxyUrl?: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const EVENT_POLL_MS = 3_000
const OAUTH_POLL_MS = 2_000
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024

/**
 * Facebook Messenger / Instagram 的薄桌面适配器。
 * OAuth、Page/IG token、Graph API 与 Webhook 都在服务器；本层只负责把服务器返回的数据
 * 转换成 UnifiedMessage，并沿用现有的翻译、通知、本地缓存和服务器主库同步管线。
 */
export class MetaAdapter extends ChannelAdapter {
  readonly kind: MetaChannel
  readonly accountId: string

  private readonly log: Logger
  private readonly getBackend: () => { url?: string; token?: string }
  private readonly openExternal: (url: string) => Promise<void>
  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>
  private status: ChannelStatus = 'stopped'
  private account: MetaAccount | undefined
  private eventTimer: ReturnType<typeof setInterval> | undefined
  private oauthTimer: ReturnType<typeof setInterval> | undefined
  private pollingEvents = false
  private pollingOauth = false
  private starting: Promise<void> | undefined
  private historyAssetId: string | undefined
  private dispatcher: Dispatcher | undefined
  private readonly profiles = new Map<string, Promise<MetaProfileResponse['profile']>>()

  constructor(options: MetaAdapterOptions) {
    super()
    this.kind = options.channel
    this.accountId = options.accountId
    this.log = (options.logger ?? noopLogger).child(`${options.channel}:${options.accountId}`)
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
    this.setState('connecting', { detail: '正在创建安全授权链接…' })
    try {
      const response = await this.api<{ url?: string }>('/api/meta/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: this.kind, accountId: this.accountId })
      })
      if (!response.url || !/^https:\/\/(www\.)?(facebook|instagram)\.com\//.test(response.url)) {
        throw new Error('服务器返回的 Meta 授权地址无效')
      }
      await this.openExternal(response.url)
      this.setState('waiting_oauth', {
        detail: this.kind === 'facebook'
          ? '请在浏览器登录 Facebook，并选择允许 OmniChat 管理消息的主页。'
          : '请在浏览器登录 Instagram 专业账号并确认授权。'
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
      const query = new URLSearchParams({ channel: this.kind, accountId: this.accountId })
      await this.api(`/api/meta/account?${query}`, { method: 'DELETE' })
    } catch (error) {
      this.log.warn('服务端 Meta 账号解绑失败', { error: errorMessage(error) })
    }
    this.account = undefined
    this.profiles.clear()
    this.historyAssetId = undefined
    await this.closeDispatcher()
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    if (!this.account || this.status !== 'connected') throw new Error('Meta 账号尚未连接')
    const result = await this.api<{ messageId?: string }>('/api/meta/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: this.kind,
        accountId: this.accountId,
        recipientId: externalChatId,
        text
      })
    })
    return { externalId: result.messageId }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    if (!this.account || this.status !== 'connected') throw new Error('Meta 账号尚未连接')
    const data = await readFile(media.filePath)
    if (data.length === 0 || data.length > MAX_OUTBOUND_MEDIA_BYTES) {
      throw new Error('Meta 媒体不能为空且不能超过 20 MB')
    }
    const result = await this.api<{ messageId?: string }>('/api/meta/send-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: this.kind,
        accountId: this.accountId,
        recipientId: externalChatId,
        mediaType: media.mediaType,
        mimeType: media.mimeType,
        dataBase64: data.toString('base64')
      })
    })
    return { externalId: result.messageId }
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    const profile = await this.profile(externalChatId)
    return profile?.name || profile?.username
  }

  override async fetchPublicId(externalChatId: string): Promise<string | undefined> {
    if (this.kind !== 'instagram') return undefined
    const username = (await this.profile(externalChatId))?.username
    return username ? `@${username.replace(/^@/, '')}` : undefined
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    if (!this.account || !externalChatId) return undefined
    return `${this.kind}:${this.account.assetId}:${externalChatId}`
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    const avatarUrl = (await this.profile(externalChatId))?.avatarUrl
    return avatarUrl ? this.downloadMedia(avatarUrl) : undefined
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    return this.account?.avatarUrl ? this.downloadMedia(this.account.avatarUrl) : undefined
  }

  private async connectExisting(): Promise<void> {
    try {
      this.requireBackend()
      this.setState('connecting', { detail: '正在检查 Meta 授权…' })
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) {
        await this.onConnected(status.account)
        return
      }
      if (status.status === 'authorizing' || status.status === 'selecting') {
        this.setState('waiting_oauth', { detail: status.detail })
        this.oauthTimer = setInterval(() => void this.pollOauth(), OAUTH_POLL_MS)
        this.oauthTimer.unref?.()
        return
      }
      if (status.status === 'error') {
        this.setState('error', { detail: status.detail })
        return
      }
      this.setState('need_credentials', { detail: status.detail })
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
      this.log.debug('授权状态轮询失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingOauth = false
    }
  }

  private async onConnected(account: MetaAccount): Promise<void> {
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
    if (this.historyAssetId !== account.assetId) {
      this.historyAssetId = account.assetId
      void this.hydrateHistory()
    }
  }

  private async hydrateHistory(): Promise<void> {
    const account = this.account
    if (!account) return
    try {
      const query = new URLSearchParams({ channel: this.kind, accountId: this.accountId })
      const response = await this.api<MetaHistoryResponse>(`/api/meta/history?${query}`)
      for (const conversation of response.conversations ?? []) {
        this.emit('conversation', {
          externalChatId: conversation.externalChatId,
          title: conversation.title,
          isGroup: false,
          lastMessageAt: conversation.updatedTime,
          lastMessagePreview: previewFor(conversation.messages.at(-1))
        })
        for (const raw of conversation.messages) {
          const mapped = mapMetaHistoryMessage(
            raw,
            this.kind,
            this.accountId,
            conversation.externalChatId,
            account
          )
          const message = await this.attachMedia(mapped.message, mapped.mediaUrl)
          this.emit('historyMessage', message)
        }
      }
    } catch (error) {
      // 历史权限（Advanced Access）尚未通过时也要保持 Webhook 新消息可用。
      this.log.warn('Meta 历史会话读取失败，新消息仍会继续接收', { error: errorMessage(error) })
    }
  }

  private async pollEvents(): Promise<void> {
    if (this.pollingEvents || !this.account || this.status !== 'connected') return
    this.pollingEvents = true
    try {
      const query = new URLSearchParams({ channel: this.kind, accountId: this.accountId })
      const response = await this.api<{ events?: MetaWebhookEnvelope[] }>(`/api/meta/events?${query}`)
      for (const envelope of response.events ?? []) {
        const mapped = mapMetaWebhook(envelope, this.kind, this.accountId, this.account)
        if (!mapped) continue
        const message = await this.attachMedia(mapped.message, mapped.mediaUrl)
        this.emit('conversation', mapped.conversation)
        this.emit('message', message)
      }
    } catch (error) {
      this.log.debug('Meta 事件拉取失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingEvents = false
    }
  }

  private async attachMedia(message: UnifiedMessage, url: string | undefined): Promise<UnifiedMessage> {
    if (!url || message.body.type !== 'media' || !this.saveMedia) return message
    const mediaId = await this.downloadMedia(url, message.body.mimeType)
    return mediaId ? { ...message, body: { ...message.body, mediaId } } : message
  }

  private async downloadMedia(url: string, hintedMime?: string): Promise<string | undefined> {
    if (!this.saveMedia || !safeMetaMediaUrl(url)) return undefined
    try {
      const response = await fetch(
        url,
        withDispatcher({ signal: AbortSignal.timeout(30_000) }, this.requiredDispatcher())
      )
      if (!response.ok) return undefined
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > MAX_MEDIA_BYTES) return undefined
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return undefined
      const mime = response.headers.get('content-type') || hintedMime
      return await this.saveMedia(data, extFromMime(mime))
    } catch (error) {
      this.log.debug('Meta 媒体下载失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private profile(userId: string): Promise<MetaProfileResponse['profile']> {
    const cached = this.profiles.get(userId)
    if (cached) return cached
    const query = new URLSearchParams({
      channel: this.kind,
      accountId: this.accountId,
      userId
    })
    const request = this.api<MetaProfileResponse>(`/api/meta/profile?${query}`)
      .then((response) => response.profile)
      .catch((error) => {
        this.log.debug('Meta 客户资料读取失败', { userId, error: errorMessage(error) })
        return undefined
      })
    this.profiles.set(userId, request)
    return request
  }

  private fetchStatus(): Promise<MetaStatusResponse> {
    const query = new URLSearchParams({ channel: this.kind, accountId: this.accountId })
    return this.api<MetaStatusResponse>(`/api/meta/account?${query}`)
  }

  private requireBackend(): { base: string; token: string } {
    const backend = this.getBackend()
    const base = backend.url?.replace(/\/$/, '')
    const token = backend.token?.trim()
    if (!base || !token) throw new Error('请先登录 OmniChat 后台，再授权 Meta 账号。')
    return { base, token }
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const { base, token } = this.requireBackend()
    const response = await fetch(
      `${base}${path}`,
      withDispatcher({
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token}` },
        signal: init.signal ?? AbortSignal.timeout(30_000)
      }, this.requiredDispatcher())
    )
    const raw = await response.text()
    let data: { error?: string } & T
    try {
      data = (raw ? JSON.parse(raw) : {}) as { error?: string } & T
    } catch {
      throw new Error(`OmniChat 后台返回异常（HTTP ${response.status}）`)
    }
    if (!response.ok) throw new Error(data.error || `OmniChat 后台 HTTP ${response.status}`)
    return data
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

function previewFor(message: MetaHistoryMessageInput | undefined): string | undefined {
  if (!message) return undefined
  if (message.text) return message.text
  const type = message.attachments[0]?.type?.toLowerCase()
  if (type?.includes('image')) return '[图片]'
  if (type?.includes('video')) return '[视频]'
  if (type?.includes('audio')) return '[语音]'
  if (type) return '[文件]'
  return undefined
}

function safeMetaMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return [
      '.fbcdn.net',
      '.fbsbx.com',
      '.cdninstagram.com',
      '.facebook.com',
      '.instagram.com'
    ].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
