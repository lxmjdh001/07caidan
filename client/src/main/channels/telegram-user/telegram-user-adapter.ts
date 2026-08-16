import { readFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { Api, TelegramClient } from 'telegram'
// GramJS 是 CJS 包且没有 exports 映射，ESM 下目录导入会被拒，必须写到具体文件
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import { createSocksProxyConfig } from '../../core/proxy'
import {
  chatIdToContactId,
  mapTgUserMessage,
  peerToChatId,
  qrLoginUrl,
  type TgPeer,
  type TgRawMedia,
  type TgRawMessage
} from './mapper'

export interface TelegramUserAdapterOptions {
  accountId: string
  logger?: Logger
  /** 应用级 API 凭证（my.telegram.org 申请），可按账号覆盖 */
  getApiCredentials: () => { apiId?: number; apiHash?: string }
  /** 已保存的会话串（登录成功后持久化，避免反复短信验证） */
  getSession: () => string | undefined
  /** 持久化会话串与登录手机号 */
  saveSession: (session: string, phone?: string) => Promise<void>
  /** 该账号的代理（住宅 socks5，防关联） */
  getProxyUrl?: () => string | undefined
  /** 该账号的设备指纹（各账号不同，防关联） */
  getDeviceFingerprint?: () => { deviceModel: string; systemVersion: string; appVersion: string }
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

/** Telegram 普通账号的登录方式 */
export type TgLoginMode = 'qr' | 'phone'

/** 交互式登录时，等待 UI 回填输入的挂起请求 */
interface PendingInput {
  resolve: (value: string) => void
  reject: (err: Error) => void
}

const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/**
 * Telegram 普通账号适配器（MTProto / GramJS）。
 *
 * 与 Bot 适配器的关键差异：
 * - 登录是多步交互（手机号 → 验证码 → 可选两步密码），通过 waiting_* 状态向 UI 索取输入
 * - 登录态以 StringSession 持久化，重启免验证码（频繁重验证会被风控视为异常）
 * - 支持按账号 SOCKS5 代理与设备指纹，用于多账号防关联
 *
 * 合规说明：MTProto 是 Telegram 官方公开协议，第三方客户端受支持；
 * 封号风险来自"行为"（群发、批量加人），本适配器只做被动接入与回复。
 */
export class TelegramUserAdapter extends ChannelAdapter {
  readonly kind = 'telegram' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly opts: TelegramUserAdapterOptions

  private client: TelegramClient | undefined
  private status: ChannelStatus = 'stopped'
  private stopping = false
  private selfId = ''
  /** 当前挂起的登录输入请求（验证码等） */
  private pending: PendingInput | undefined
  /** 登录中缓存的手机号 */
  private phone = ''
  /** 登录方式；与官方客户端一致，默认扫码 */
  private loginMode: TgLoginMode = 'qr'

  constructor(opts: TelegramUserAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.opts = opts
    this.log = (opts.logger ?? noopLogger).child(`telegram:${opts.accountId}`)
  }

  async start(): Promise<void> {
    this.stopping = false
    const { apiId, apiHash } = this.opts.getApiCredentials()
    if (!apiId || !apiHash) {
      // 正常情况下走内置凭证，不该到这里；说明这个版本打包时没注入 OMNI_TG_API_ID
      this.setState('need_credentials', {
        detail: '本版本未内置 Telegram 应用凭证，请在全局设置或账号高级设置里填写 API ID / API Hash'
      })
      return
    }

    this.setState('connecting')
    try {
      const session = new StringSession(this.opts.getSession() ?? '')
      const proxy = createSocksProxyConfig(this.opts.getProxyUrl?.())
      const fp = this.opts.getDeviceFingerprint?.()
      if (proxy) this.log.info('使用代理连接', { ip: proxy.ip, port: proxy.port })

      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        // 多账号防关联：各账号上报不同设备标识
        deviceModel: fp?.deviceModel,
        systemVersion: fp?.systemVersion,
        appVersion: fp?.appVersion,
        ...(proxy ? { proxy } : {})
      })
      this.client = client

      const password = async (hint?: string): Promise<string> => {
        this.setState('waiting_password', {
          detail: hint ? `两步验证密码（提示：${hint}）` : '请输入两步验证密码'
        })
        return this.awaitInput()
      }
      const onError = async (err: Error): Promise<boolean> => {
        this.log.error('登录失败', err)
        this.setState('error', { detail: err.message })
        // 返回 true 终止登录流程，避免 GramJS 无限重试
        return true
      }

      await client.connect()
      if (await client.checkAuthorization()) {
        this.log.info('已有会话，免登录')
      } else if (this.loginMode === 'qr') {
        // 扫码登录：GramJS 会自动续期令牌并反复回调，这里每次重画二维码
        await client.signInUserWithQrCode(
          { apiId, apiHash },
          {
            qrCode: async (qr) => {
              const dataUrl = await QRCode.toDataURL(qrLoginUrl(qr.token), {
                margin: 1,
                width: 320
              })
              this.setState('waiting_qr', {
                qrDataUrl: dataUrl,
                detail: '用手机 Telegram 扫码：设置 → 设备 → 关联桌面设备'
              })
            },
            password,
            onError
          }
        )
      } else {
        await client.start({
          phoneNumber: async () => {
            if (this.phone) return this.phone
            this.setState('waiting_phone', { detail: '请输入该账号的手机号（含国家码）' })
            this.phone = await this.awaitInput()
            return this.phone
          },
          phoneCode: async (isCodeViaApp?: boolean) => {
            this.setState('waiting_code', {
              detail: isCodeViaApp ? '验证码已发送到 Telegram 应用内' : '验证码已发短信'
            })
            return this.awaitInput()
          },
          password,
          onError
        })
      }

      // 登录成功：持久化会话串，下次免验证码
      const saved = client.session.save() as unknown as string
      if (saved) await this.opts.saveSession(saved, this.phone || undefined)

      const me = await client.getMe()
      this.selfId = String((me as Api.User).id)
      const selfName =
        [(me as Api.User).firstName, (me as Api.User).lastName].filter(Boolean).join(' ') ||
        (me as Api.User).username ||
        undefined

      client.addEventHandler((event: NewMessageEvent) => {
        void this.handleEvent(event)
      }, new NewMessage({}))

      this.setState('connected', { selfName })
      this.log.info('连接成功', { user: this.selfId })
    } catch (err) {
      if (this.stopping) return
      this.log.error('启动失败', err)
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 切换登录方式并重新开始登录。
   * 必须先断开：GramJS 的登录流程挂在连接上，不重建客户端切不过去。
   */
  override async setLoginMode(mode: string): Promise<void> {
    const next: TgLoginMode = mode === 'phone' ? 'phone' : 'qr'
    if (next === this.loginMode && this.status !== 'error') return
    this.loginMode = next
    this.phone = ''
    await this.stop()
    await this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.rejectPending('已停止')
    try {
      await this.client?.disconnect()
    } catch {
      // 断开失败不影响停止
    }
    this.client = undefined
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.rejectPending('已退出登录')
    try {
      await this.client?.invoke(new Api.auth.LogOut())
    } catch (err) {
      this.log.warn('注销请求失败，仍清除本地会话', { err: String(err) })
    }
    try {
      await this.client?.disconnect()
    } catch {
      // 忽略
    }
    this.client = undefined
    this.phone = ''
    await this.opts.saveSession('', undefined)
    this.setState('logged_out')
  }

  /** UI 回填手机号 / 验证码 / 两步密码 */
  override async submitAuthInput(value: string): Promise<void> {
    const p = this.pending
    if (!p) {
      this.log.warn('当前无待输入的登录步骤，忽略提交')
      return
    }
    this.pending = undefined
    p.resolve(value.trim())
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    const client = this.requireClient()
    const msg = await client.sendMessage(this.toEntity(externalChatId), { message: text })
    return { externalId: String(msg.id) }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    const client = this.requireClient()
    const buf = await readFile(media.filePath)
    const file = new (await import('telegram/client/uploads')).CustomFile(
      media.fileName,
      buf.length,
      media.filePath,
      buf
    )
    const msg = await client.sendFile(this.toEntity(externalChatId), {
      file,
      caption: media.caption,
      // 语音/视频以可播放形式发送，其余作为文件
      voiceNote: media.mediaType === 'audio',
      videoNote: false,
      forceDocument: media.mediaType === 'document'
    })
    return { externalId: String(msg.id) }
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    return chatIdToContactId(externalChatId)
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    const client = this.client
    if (!client || this.status !== 'connected') return undefined
    try {
      const entity = await client.getEntity(this.toEntity(externalChatId))
      if (entity instanceof Api.User) {
        return (
          [entity.firstName, entity.lastName].filter(Boolean).join(' ') ||
          entity.username ||
          undefined
        )
      }
      if (entity instanceof Api.Chat || entity instanceof Api.Channel) return entity.title
      return undefined
    } catch {
      return undefined
    }
  }

  // ── 内部 ──

  /** 挂起等待 UI 输入；stop/logout 时会被 reject */
  private awaitInput(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  private rejectPending(reason: string): void {
    this.pending?.reject(new Error(reason))
    this.pending = undefined
  }

  private requireClient(): TelegramClient {
    if (!this.client || this.status !== 'connected') throw new Error('Telegram 未连接，无法发送')
    return this.client
  }

  /** 外部会话 id → GramJS 实体标识（群带 g 前缀，需还原成负数/原 id） */
  private toEntity(externalChatId: string): string {
    return externalChatId.startsWith('g') ? externalChatId.slice(1) : externalChatId
  }

  private async handleEvent(event: NewMessageEvent): Promise<void> {
    try {
      const raw = this.toRawMessage(event)
      if (!raw) return
      const mapped = mapTgUserMessage(raw, this.accountId)
      if (!mapped) return

      this.emit('message', mapped)
      this.emit('conversation', {
        externalChatId: peerToChatId(raw.peer),
        isGroup: raw.peer.type !== 'user'
      })
      if (raw.media && this.saveMediaEnabled() && mapped.body.type === 'media') {
        void this.downloadMedia(event, mapped)
      }
    } catch (err) {
      this.log.warn('处理消息失败', { err: String(err) })
    }
  }

  private saveMediaEnabled(): boolean {
    return typeof this.opts.saveMedia === 'function'
  }

  /** GramJS 事件 → mapper 的结构化输入 */
  private toRawMessage(event: NewMessageEvent): TgRawMessage | null {
    const m = event.message
    if (!m) return null
    const peer = toPeer(m.peerId)
    if (!peer) return null

    const senderName = extractSenderName(event)
    return {
      id: m.id,
      text: m.message ?? '',
      date: m.date,
      out: !!m.out,
      peer,
      senderName,
      media: toRawMedia(m.media)
    }
  }

  private async downloadMedia(event: NewMessageEvent, msg: UnifiedMessage): Promise<void> {
    const saveMedia = this.opts.saveMedia
    const client = this.client
    if (!saveMedia || !client || msg.body.type !== 'media') return
    try {
      const buf = (await client.downloadMedia(event.message, {})) as Buffer | undefined
      if (!buf || buf.length === 0) return
      if (buf.length > MAX_MEDIA_BYTES) {
        this.log.warn('媒体超过大小上限，跳过', { size: buf.length })
        return
      }
      const mediaId = await saveMedia(buf, extFromMime(msg.body.mimeType))
      this.emit('messageUpdate', { ...msg, body: { ...msg.body, mediaId } })
    } catch (err) {
      this.log.warn('媒体下载失败', { err: String(err) })
    }
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; selfName?: string; qrDataUrl?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

/** Api.Peer* → mapper 的 TgPeer */
function toPeer(peerId: unknown): TgPeer | null {
  if (peerId instanceof Api.PeerUser) return { type: 'user', id: String(peerId.userId) }
  if (peerId instanceof Api.PeerChat) return { type: 'chat', id: String(peerId.chatId) }
  if (peerId instanceof Api.PeerChannel) return { type: 'channel', id: String(peerId.channelId) }
  return null
}

function extractSenderName(event: NewMessageEvent): string | undefined {
  const sender = (event.message as { sender?: unknown }).sender
  if (sender instanceof Api.User) {
    return (
      [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || undefined
    )
  }
  return undefined
}

/** Api.MessageMedia* → mapper 的媒体描述 */
function toRawMedia(media: unknown): TgRawMedia | undefined {
  if (!media || media instanceof Api.MessageMediaEmpty) return undefined
  if (media instanceof Api.MessageMediaPhoto) return { kind: 'image' }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    if (!(doc instanceof Api.Document)) return { kind: 'document' }
    const attrs = doc.attributes ?? []
    const fileName = attrs.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename
    )?.fileName
    const audio = attrs.find(
      (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio
    )
    const video = attrs.find(
      (a): a is Api.DocumentAttributeVideo => a instanceof Api.DocumentAttributeVideo
    )
    const isSticker = attrs.some((a) => a instanceof Api.DocumentAttributeSticker)

    if (isSticker) return { kind: 'sticker', mimeType: doc.mimeType }
    if (audio) return { kind: 'audio', mimeType: doc.mimeType, fileName, durationSec: audio.duration }
    if (video) return { kind: 'video', mimeType: doc.mimeType, fileName, durationSec: video.duration }
    return { kind: 'document', mimeType: doc.mimeType, fileName }
  }
  return { kind: 'other' }
}
