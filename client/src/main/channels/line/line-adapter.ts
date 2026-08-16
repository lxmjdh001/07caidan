import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import {
  isLineGroup,
  lineChatId,
  lineContactId,
  mapLineEvent,
  type LineEvent
} from './mapper'

export interface LineCreds {
  channelAccessToken?: string
  channelSecret?: string
  /** LINE Developers 的 Provider ID；决定 userId 的作用域，跨账号判重要靠它 */
  providerId?: string
}

export interface LineAdapterOptions {
  accountId: string
  logger?: Logger
  getCreds: () => LineCreds
  /** 后台中转地址与令牌（收信必需：LINE 只支持公网 Webhook） */
  getBackend: () => { url?: string; token?: string }
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const PULL_INTERVAL_MS = 5000

/**
 * LINE 渠道适配器。
 * 发信：客户端直连 LINE Messaging API（push）。
 * 收信：LINE 只支持公网 Webhook，无法纯客户端；经后台中转 —
 *   客户端把 channelSecret 注册到后台，后台收 Webhook 入队，客户端轮询拉取。
 * 因此 LINE 需要登录后台账号并开启同步。
 */
export class LineAdapter extends ChannelAdapter {
  readonly kind = 'line' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly getCreds: () => LineCreds
  private readonly getBackend: () => { url?: string; token?: string }
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>

  private status: ChannelStatus = 'stopped'
  private stopping = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: LineAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.log = (opts.logger ?? noopLogger).child(`line:${opts.accountId}`)
    this.getCreds = opts.getCreds
    this.getBackend = opts.getBackend
    this.saveMedia = opts.saveMedia
  }

  async start(): Promise<void> {
    this.stopping = false
    const creds = this.getCreds()
    if (!creds.channelAccessToken || !creds.channelSecret) {
      this.setState('need_credentials', { detail: '请在账号设置填写 LINE 凭证' })
      return
    }
    const backend = this.getBackend()
    if (!backend.url || !backend.token) {
      this.setState('error', { detail: 'LINE 收信需先登录后台账号（收信经后台 Webhook 中转）' })
      return
    }
    this.setState('connecting')
    try {
      // 向后台注册本 LINE 账号（channelSecret 用于 Webhook 验签），拿到 Webhook 地址
      const reg = await this.backendPost('/api/line/register', {
        accountId: this.accountId,
        channelSecret: creds.channelSecret
      })
      const webhookUrl = (reg as { webhookUrl?: string }).webhookUrl
      this.setState('connected', {
        detail: webhookUrl ? `Webhook: ${webhookUrl}（填到 LINE 后台）` : undefined
      })
      this.log.info('已注册到后台中转', { webhookUrl })
      this.timer = setInterval(() => void this.pull(), PULL_INTERVAL_MS)
    } catch (err) {
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    await this.stop()
    this.setState('logged_out')
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    const scope = this.getCreds().providerId?.trim() || `acct-${this.accountId}`
    return lineContactId(externalChatId, scope)
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    await this.linePush(externalChatId, [{ type: 'text', text }])
    return {}
  }

  /** 从后台拉取本账号的待处理 Webhook 事件 */
  private async pull(): Promise<void> {
    if (this.stopping) return
    try {
      const data = (await this.backendGet(`/api/line/pull?accountId=${this.accountId}`)) as {
        events?: LineEvent[]
      }
      for (const ev of data.events ?? []) {
        const mapped = mapLineEvent(ev, this.accountId)
        if (!mapped) continue
        this.emit('message', mapped.message)
        this.emit('conversation', {
          externalChatId: lineChatId(ev.source),
          isGroup: isLineGroup(ev.source)
        })
        if (mapped.messageId && this.saveMedia && mapped.message.body.type === 'media') {
          void this.fetchContent(mapped.messageId, mapped.message)
        }
      }
    } catch (err) {
      this.log.debug('拉取 LINE 事件失败', { err: String(err) })
    }
  }

  /** 拉取消息媒体内容（LINE content endpoint） */
  private async fetchContent(messageId: string, msg: UnifiedMessage): Promise<void> {
    if (!this.saveMedia || msg.body.type !== 'media') return
    const token = this.getCreds().channelAccessToken
    if (!token) return
    try {
      const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) return
      const buf = Buffer.from(await res.arrayBuffer())
      const mediaId = await this.saveMedia(buf, extFromMime(msg.body.mimeType))
      this.emit('messageUpdate', { ...msg, body: { ...msg.body, mediaId } })
    } catch (err) {
      this.log.debug('LINE 媒体拉取失败', { err: String(err) })
    }
  }

  private async linePush(to: string, messages: unknown[]): Promise<void> {
    const token = this.getCreds().channelAccessToken
    if (!token) throw new Error('缺少 LINE channelAccessToken')
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`LINE push HTTP ${res.status}`)
  }

  private async backendPost(path: string, body: unknown): Promise<unknown> {
    const { url, token } = this.getBackend()
    const res = await fetch(`${url!.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`后台 ${path} HTTP ${res.status}`)
    return res.json()
  }

  private async backendGet(path: string): Promise<unknown> {
    const { url, token } = this.getBackend()
    const res = await fetch(`${url!.replace(/\/$/, '')}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`后台 ${path} HTTP ${res.status}`)
    return res.json()
  }

  private setState(status: ChannelStatus, extra: { detail?: string; selfName?: string } = {}): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}
