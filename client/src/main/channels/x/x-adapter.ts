import type { Dispatcher } from 'undici'
import { readFile } from 'node:fs/promises'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { extFromMime } from '../../core/mime'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, withDispatcher } from '../../core/proxy'
import { mapXMessage, previewXMessage, type XAccountSummary, type XMessageInput } from './mapper'

interface XAccount extends XAccountSummary {
  channel: 'x'
  accountId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

interface XProfile {
  id: string
  name?: string
  username?: string
  profile_image_url?: string
  contactId?: string
}

interface XStatusResponse {
  status: 'connected' | 'authorizing' | 'error' | 'disconnected'
  detail?: string
  account?: XAccount
}

interface XHistoryResponse {
  conversations?: Array<{
    externalChatId: string
    title: string
    publicId?: string
    contactId?: string
    avatarUrl?: string
    isGroup: boolean
    updatedTime: number
    messages: XMessageInput[]
  }>
}

export interface XAdapterOptions {
  accountId: string
  logger?: Logger
  getBackend: () => { url?: string; token?: string }
  openExternal: (url: string) => Promise<void>
  getProxyUrl?: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const OAUTH_POLL_MS = 2_000
// X /2/dm_events 的用户级上限较低；75 秒轮询给多个账号留出余量。
const HISTORY_POLL_MS = 75_000
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_OUTBOUND_IMAGE_BYTES = 5 * 1024 * 1024

export class XAdapter extends ChannelAdapter {
  readonly kind = 'x' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly getBackend: () => { url?: string; token?: string }
  private readonly openExternal: (url: string) => Promise<void>
  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>
  private status: ChannelStatus = 'stopped'
  private account: XAccount | undefined
  private oauthTimer: ReturnType<typeof setInterval> | undefined
  private historyTimer: ReturnType<typeof setInterval> | undefined
  private pollingOauth = false
  private pollingHistory = false
  private starting: Promise<void> | undefined
  private initialized = false
  private dispatcher: Dispatcher | undefined
  private readonly seenIds = new Set<string>()
  private readonly profiles = new Map<string, XProfile>()

  constructor(options: XAdapterOptions) {
    super()
    this.accountId = options.accountId
    this.log = (options.logger ?? noopLogger).child(`x:${options.accountId}`)
    this.getBackend = options.getBackend
    this.openExternal = options.openExternal
    this.getProxyUrl = options.getProxyUrl ?? (() => undefined)
    this.saveMedia = options.saveMedia
  }

  async start(): Promise<void> {
    if (this.starting || this.historyTimer) return
    await this.resetDispatcher()
    this.starting = this.connectExisting().finally(() => { this.starting = undefined })
    await this.starting
  }

  override async beginOAuth(): Promise<void> {
    this.requireBackend()
    await this.resetDispatcher()
    this.clearOauthTimer()
    this.setState('connecting', { detail: '正在创建 X 安全授权链接…' })
    try {
      const response = await this.api<{ url?: string }>('/api/x/oauth/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: this.accountId })
      })
      if (!response.url || new URL(response.url).hostname !== 'x.com') {
        throw new Error('服务器返回的 X 授权地址无效')
      }
      await this.openExternal(response.url)
      this.setState('waiting_oauth', { detail: '请在浏览器登录 X，并允许 OmniChat 读取和回复私信。' })
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
      await this.api(`/api/x/account?${new URLSearchParams({ accountId: this.accountId })}`, { method: 'DELETE' })
    } catch (error) {
      this.log.warn('服务端 X 账号解绑失败', { error: errorMessage(error) })
    }
    this.account = undefined
    this.profiles.clear()
    this.seenIds.clear()
    this.initialized = false
    await this.closeDispatcher()
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    this.assertConnected()
    const result = await this.api<{ messageId?: string }>('/api/x/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, conversationId: externalChatId, text })
    })
    return { externalId: result.messageId }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    this.assertConnected()
    if (media.mediaType !== 'image') throw new Error('X 私信目前只支持从 OmniChat 发送图片。')
    const mimeType = media.mimeType.split(';', 1)[0]?.toLowerCase() || ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      throw new Error('X 私信图片仅支持 JPG、PNG 或 WebP。')
    }
    const data = await readFile(media.filePath)
    if (data.length === 0 || data.length > MAX_OUTBOUND_IMAGE_BYTES) {
      throw new Error('X 私信图片不能为空且不能超过 5 MB。')
    }
    const result = await this.api<{ messageId?: string }>('/api/x/send-media', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: this.accountId,
        conversationId: externalChatId,
        mimeType,
        dataBase64: data.toString('base64'),
        text: media.caption?.trim() || undefined
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
    const profile = await this.profile(externalChatId)
    return profile?.contactId || (profile?.id ? `x:${profile.id}` : undefined)
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    const url = (await this.profile(externalChatId))?.profile_image_url
    return url ? this.downloadMedia(url) : undefined
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    return this.account?.avatarUrl ? this.downloadMedia(this.account.avatarUrl) : undefined
  }

  private async connectExisting(): Promise<void> {
    try {
      this.requireBackend()
      this.setState('connecting', { detail: '正在检查 X 授权…' })
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) return await this.onConnected(status.account)
      if (status.status === 'authorizing') {
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
      }
    } catch (error) {
      this.log.debug('X 授权状态轮询失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingOauth = false
    }
  }

  private async onConnected(account: XAccount): Promise<void> {
    this.account = account
    this.requiredDispatcher()
    this.setState('connected', {
      selfName: account.displayName,
      selfHandle: account.handle ? `@${account.handle.replace(/^@/, '')}` : undefined
    })
    await this.pollHistory(true)
    if (!this.historyTimer) {
      this.historyTimer = setInterval(() => void this.pollHistory(), HISTORY_POLL_MS)
      this.historyTimer.unref?.()
    }
  }

  private async pollHistory(initial = false): Promise<void> {
    if (this.pollingHistory || !this.account || this.status !== 'connected') return
    this.pollingHistory = true
    try {
      const query = new URLSearchParams({ accountId: this.accountId })
      const response = await this.api<XHistoryResponse>(`/api/x/history?${query}`)
      for (const conversation of response.conversations ?? []) {
        this.profiles.set(conversation.externalChatId, {
          id: contactTail(conversation.contactId) || conversation.externalChatId,
          name: conversation.title,
          username: conversation.publicId?.replace(/^@/, ''),
          profile_image_url: conversation.avatarUrl,
          contactId: conversation.contactId
        })
        this.emit('conversation', {
          externalChatId: conversation.externalChatId,
          title: conversation.title,
          publicId: conversation.publicId,
          contactId: conversation.contactId,
          isGroup: conversation.isGroup,
          lastMessageAt: conversation.updatedTime,
          lastMessagePreview: previewXMessage(conversation.messages.at(-1))
        })
        for (const raw of conversation.messages) {
          const mapped = mapXMessage(raw, this.accountId, conversation.externalChatId, this.account)
          const id = mapped.message.externalId || mapped.message.id
          if (this.seenIds.has(id)) continue
          this.remember(id)
          const message = await this.attachMedia(mapped.message, mapped.mediaUrl)
          this.emit(initial || !this.initialized ? 'historyMessage' : 'message', message)
        }
      }
      this.initialized = true
    } catch (error) {
      this.log.warn('X 私信历史读取失败，下轮自动重试', { error: errorMessage(error) })
    } finally {
      this.pollingHistory = false
    }
  }

  private async attachMedia(message: UnifiedMessage, url: string | undefined): Promise<UnifiedMessage> {
    if (!url || message.body.type !== 'media') return message
    const mediaId = await this.downloadMedia(url, message.body.mimeType)
    return mediaId ? { ...message, body: { ...message.body, mediaId } } : message
  }

  private async downloadMedia(url: string, hintedMime?: string): Promise<string | undefined> {
    if (!this.saveMedia || !safeXMediaUrl(url)) return undefined
    try {
      const response = await fetch(url, withDispatcher({ signal: AbortSignal.timeout(30_000) }, this.requiredDispatcher()))
      if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_MEDIA_BYTES) return undefined
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return undefined
      return await this.saveMedia(data, extFromMime(response.headers.get('content-type') || hintedMime))
    } catch (error) {
      this.log.debug('X 媒体下载失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private async profile(externalChatId: string): Promise<XProfile | undefined> {
    const cached = this.profiles.get(externalChatId)
    if (cached) return cached
    const userId = directPeerId(externalChatId, this.account?.userId)
    if (!userId) return undefined
    try {
      const response = await this.api<{ profile?: XProfile }>(
        `/api/x/profile?${new URLSearchParams({ accountId: this.accountId, userId })}`
      )
      if (!response.profile) return undefined
      const profile = { ...response.profile, contactId: `x:${response.profile.id}` }
      this.profiles.set(externalChatId, profile)
      return profile
    } catch (error) {
      this.log.debug('X 用户资料读取失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private remember(id: string): void {
    this.seenIds.add(id)
    if (this.seenIds.size > 20_000) this.seenIds.delete(this.seenIds.values().next().value!)
  }

  private fetchStatus(): Promise<XStatusResponse> {
    return this.api(`/api/x/account?${new URLSearchParams({ accountId: this.accountId })}`)
  }

  private assertConnected(): void {
    if (!this.account || this.status !== 'connected') throw new Error('X 账号尚未连接')
  }

  private requireBackend(): { base: string; token: string } {
    const backend = this.getBackend()
    const base = backend.url?.replace(/\/$/, '')
    const token = backend.token?.trim()
    if (!base || !token) throw new Error('请先登录 OmniChat 后台，再授权 X 账号。')
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
    let data: { error?: string }
    try { data = raw ? JSON.parse(raw) as { error?: string } : {} } catch { throw new Error(`OmniChat 后台返回了无法解析的数据（HTTP ${response.status}）`) }
    if (!response.ok) throw new Error(data.error || `OmniChat 后台 HTTP ${response.status}`)
    return data as T
  }

  private clearOauthTimer(): void {
    if (this.oauthTimer) clearInterval(this.oauthTimer)
    this.oauthTimer = undefined
  }

  private clearTimers(): void {
    this.clearOauthTimer()
    if (this.historyTimer) clearInterval(this.historyTimer)
    this.historyTimer = undefined
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

  private setState(status: ChannelStatus, extra: { detail?: string; selfName?: string; selfHandle?: string } = {}): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function directPeerId(conversationId: string, selfId: string | undefined): string | undefined {
  const ids = conversationId.split('-').filter((part) => /^\d+$/.test(part) && part !== selfId)
  return ids.length === 1 ? ids[0] : undefined
}

function contactTail(value: string | undefined): string | undefined {
  return value?.startsWith('x:') ? value.slice(2) : undefined
}

function safeXMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    return ['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com', 'abs.twimg.com'].includes(host) || host.endsWith('.twimg.com')
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
