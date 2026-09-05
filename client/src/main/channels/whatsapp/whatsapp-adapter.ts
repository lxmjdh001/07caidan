import { rm } from 'node:fs/promises'
import {
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage
} from 'baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type GroupSummary, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import {
  createRequiredDispatcher,
  createRequiredProxyAgent,
  redactProxyUrl,
  withDispatcher
} from '../../core/proxy'
import type { Dispatcher } from 'undici'
import type { Agent } from 'node:https'
import { deviceIdentity } from './device-identity'
import { isGroupJid, mapWaMessage, mediaFileLength, type WaRawMessage } from './mapper'

export interface WhatsAppAdapterOptions {
  accountId: string
  /** 登录凭证目录（多账号各一个） */
  authDir: string
  logger?: Logger
  /**
   * 该账号的代理地址提供函数（socks5:// 或 http://），每次建立连接时读取，
   * 必填；为空或不可用时必须失败关闭，绝不回落到默认网络。
   */
  getProxyUrl?: () => string | undefined
  /** 保存下载的媒体，返回 mediaId（由核心层 MediaStore 提供） */
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
  /** 自定义设备名（Linked Devices 里显示）；留空则按账号自动派生 */
  getDeviceLabel?: () => string | undefined
  /** 固定设备指纹种子；同账号稳定、不同账号隔离。 */
  getFingerprintSeed?: () => string | undefined
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000
/** 超过此大小的媒体不自动下载（避免大视频占满内存/磁盘） */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

function normalizeParticipantJid(value: string): string {
  const raw = value.trim()
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw
  const digits = raw.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : ''
}

/**
 * WhatsApp 渠道适配器（Baileys v7，WebSocket 直连 WhatsApp Web 协议）。
 * 连接完全跑在客户端本地：扫码登录后凭证保存在本机，流量走用户自己的网络。
 */
export class WhatsAppAdapter extends ChannelAdapter {
  readonly kind = 'whatsapp' as const
  readonly accountId: string

  private readonly authDir: string
  private readonly log: Logger
  /** Baileys 内部日志：error 级别输出到 stdout，解密/协议错误必须可见 */
  private readonly waLogger = pino({ level: 'error' })
  /** 最近发出的消息内容缓存，供对端请求重发（getMessage）使用 */
  private readonly sentCache = new Map<string, unknown>()

  private sock: ReturnType<typeof makeWASocket> | undefined
  private status: ChannelStatus = 'stopped'
  private selfAvatarUrl?: string
  private selfAvatarMediaId?: string
  private stopping = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay = RECONNECT_BASE_MS
  private dispatcher: Dispatcher | undefined
  private proxyAgent: Agent | undefined

  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>
  private readonly getDeviceLabel: () => string | undefined
  private readonly getFingerprintSeed: () => string | undefined

  constructor(opts: WhatsAppAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.authDir = opts.authDir
    this.getProxyUrl = opts.getProxyUrl ?? (() => undefined)
    this.saveMedia = opts.saveMedia
    this.getDeviceLabel = opts.getDeviceLabel ?? (() => undefined)
    this.getFingerprintSeed = opts.getFingerprintSeed ?? (() => undefined)
    this.log = (opts.logger ?? noopLogger).child(`whatsapp:${opts.accountId}`)
  }

  async start(): Promise<void> {
    this.stopping = false
    this.setState('connecting')
    try {
      await this.connect()
    } catch (err) {
      this.log.error('启动连接失败', err)
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
      this.scheduleReconnect()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnect()
    try {
      this.sock?.end(undefined)
    } catch {
      // socket 可能已关闭
    }
    this.sock = undefined
    await this.closeProxyResources()
    this.setState('stopped')
    this.log.info('已停止')
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.clearReconnect()
    try {
      await this.sock?.logout()
    } catch (err) {
      this.log.warn('调用 logout 失败（可能已断开），继续清除本地凭证', err)
    }
    this.sock = undefined
    await this.closeProxyResources()
    await rm(this.authDir, { recursive: true, force: true })
    this.setState('logged_out')
    this.log.info('已退出登录并清除凭证')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法发送')
    }
    const result = await this.sock.sendMessage(externalChatId, { text })
    this.cacheSent(result?.key?.id, result?.message)
    this.log.debug('消息已发送', { to: externalChatId, id: result?.key?.id })
    return { externalId: result?.key?.id ?? undefined }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法发送')
    }
    const content = toWaMediaContent(media)
    const result = await this.sock.sendMessage(externalChatId, content)
    this.cacheSent(result?.key?.id, result?.message)
    this.log.debug('媒体已发送', { to: externalChatId, type: media.mediaType, id: result?.key?.id })
    return { externalId: result?.key?.id ?? undefined }
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    if (!this.sock || this.status !== 'connected') return undefined
    // 群聊：拉群元数据取群名
    if (isGroupJid(externalChatId)) {
      const meta = await this.sock.groupMetadata(externalChatId).catch(() => undefined)
      return meta?.subject || undefined
    }
    // 官方机器人会话
    if (externalChatId.endsWith('@bot')) return 'Meta AI'
    // LID（隐私隐藏 ID）：映射回真实手机号，与手机端显示一致
    if (externalChatId.endsWith('@lid')) {
      const pn = await this.sock.signalRepository?.lidMapping
        ?.getPNForLID(externalChatId)
        .catch(() => null)
      const number = pn?.split('@')[0]?.split(':')[0]
      return number ? `+${number}` : undefined
    }
    // 自己的会话（Message Yourself）
    const selfJid = this.sock.user?.id?.split(':')[0]
    if (selfJid && externalChatId.startsWith(`${selfJid}@`)) {
      const name = this.sock.user?.name
      return name ? `${name}（我）` : '我'
    }
    // 普通联系人：显示手机号（昵称靠 pushName / 通讯录同步事件覆盖）
    if (externalChatId.endsWith('@s.whatsapp.net')) {
      const number = externalChatId.split('@')[0]?.split(':')[0]
      return number ? `+${number}` : undefined
    }
    return undefined
  }

  override async listGroups(): Promise<GroupSummary[]> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法读取群组')
    }
    const groups = await this.sock.groupFetchAllParticipating()
    return Object.values(groups).map((group) => ({
      externalChatId: group.id,
      title: group.subject || '未命名群组',
      participantIds: (group.participants ?? []).map((participant) => participant.id)
    }))
  }

  override async createGroup(subject: string, participantIds: string[]): Promise<GroupSummary> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法创建群组')
    }
    const name = subject.trim()
    if (!name) throw new Error('群组名称不能为空')
    const participants = [...new Set((await Promise.all(participantIds.map((id) => this.resolveParticipantJid(id)))).filter(Boolean))]
    if (participants.length === 0) throw new Error('请至少选择一位成员')
    const lookupNumbers = participants.map((jid) => jid.split('@')[0]?.split(':')[0] ?? jid)
    const checked = await this.sock.onWhatsApp(...lookupNumbers).catch(() => undefined)
    const validParticipants = checked ? checked.filter((entry) => entry.exists).map((entry) => entry.jid) : participants
    if (validParticipants.length === 0) throw new Error('所选联系人无法加入群组，请重新选择')
    const group = await this.sock.groupCreate(name, validParticipants)
    return {
      externalChatId: group.id,
      title: group.subject || name,
      participantIds: (group.participants ?? []).map((participant) => participant.id)
    }
  }

  private async resolveParticipantJid(value: string): Promise<string> {
    const raw = value.trim()
    if (raw.endsWith('@lid')) {
      const mapped = await this.sock?.signalRepository?.lidMapping?.getPNForLID(raw).catch(() => null)
      return mapped ? normalizeParticipantJid(mapped) : ''
    }
    return normalizeParticipantJid(raw)
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    // 群聊与机器人没有自然人身份
    if (isGroupJid(externalChatId) || externalChatId.endsWith('@bot')) return undefined
    // 普通号码 jid → 直接取号
    if (externalChatId.endsWith('@s.whatsapp.net')) {
      const number = externalChatId.split('@')[0]?.split(':')[0]
      return number ? `wa:+${number}` : undefined
    }
    // LID → 映射回手机号（映射未就绪时返回 undefined，下次运行会重试）
    if (externalChatId.endsWith('@lid')) {
      const pn = await this.sock?.signalRepository?.lidMapping
        ?.getPNForLID(externalChatId)
        .catch(() => null)
      const number = pn?.split('@')[0]?.split(':')[0]
      return number ? `wa:+${number}` : undefined
    }
    return undefined
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    return this.downloadProfilePicture(externalChatId)
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    const user = this.sock?.user as ({ id?: string; lid?: string } | undefined)
    const candidates = [user?.id, user?.lid]
      .filter((jid): jid is string => !!jid)
      .flatMap((jid) => [jid, jid.replace(/:\d+(?=@)/, '')])
    for (const jid of candidates) {
      const mediaId = await this.downloadSelfProfilePicture(jid)
      if (mediaId) return mediaId
    }
    return undefined
  }

  private async downloadSelfProfilePicture(jid: string): Promise<string | undefined> {
    if (!this.sock || this.status !== 'connected' || !this.saveMedia) return undefined
    const url = await this.sock.profilePictureUrl(jid, 'image').catch(() => undefined)
    if (!url) return undefined
    if (url === this.selfAvatarUrl && this.selfAvatarMediaId) return this.selfAvatarMediaId
    const res = await fetch(
      url,
      withDispatcher({ signal: AbortSignal.timeout(15_000) }, this.requiredDispatcher())
    )
    if (!res.ok) return undefined
    const buffer = Buffer.from(await res.arrayBuffer())
    const mediaId = await this.saveMedia(buffer, '.jpg')
    this.selfAvatarUrl = url
    this.selfAvatarMediaId = mediaId
    return mediaId
  }

  private async downloadProfilePicture(jid: string): Promise<string | undefined> {
    if (!this.sock || this.status !== 'connected' || !this.saveMedia) return undefined
    // 无头像/无权限查看时 profilePictureUrl 会抛错，视为无头像
    const url = await this.sock.profilePictureUrl(jid, 'image').catch(() => undefined)
    if (!url) return undefined
    const res = await fetch(
      url,
      withDispatcher({ signal: AbortSignal.timeout(15_000) }, this.requiredDispatcher())
    )
    if (!res.ok) return undefined
    const buffer = Buffer.from(await res.arrayBuffer())
    return this.saveMedia(buffer, '.jpg')
  }

  private cacheSent(id: string | null | undefined, message: unknown): void {
    if (!id || !message) return
    this.sentCache.set(id, message)
    // 只保留最近 200 条
    if (this.sentCache.size > 200) {
      const first = this.sentCache.keys().next().value
      if (first) this.sentCache.delete(first)
    }
  }

  /** 后台下载入站媒体，成功后通过 messageUpdate 补上 mediaId */
  private async downloadIncomingMedia(raw: unknown, msg: UnifiedMessage): Promise<void> {
    if (!this.saveMedia || msg.body.type !== 'media') return

    const size = mediaFileLength((raw as WaRawMessage).message)
    if (size > MAX_MEDIA_BYTES) {
      this.log.warn('媒体超过大小上限，跳过下载', { size, externalId: msg.externalId })
      return
    }

    try {
      const buffer = (await downloadMediaMessage(raw as WAMessage, 'buffer', {
        options: withDispatcher({}, this.requiredDispatcher())
      }, {
        logger: this.waLogger,
        reuploadRequest: (m) => this.sock!.updateMediaMessage(m)
      })) as Buffer
      const mediaId = await this.saveMedia(buffer, extFromMime(msg.body.mimeType))
      this.emit('messageUpdate', { ...msg, body: { ...msg.body, mediaId } })
    } catch (err) {
      this.log.warn('媒体下载失败', { externalId: msg.externalId, err: String(err) })
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    await this.closeProxyResources()
    const proxyUrl = this.getProxyUrl()
    const agent = createRequiredProxyAgent(proxyUrl)
    const dispatcher = createRequiredDispatcher(proxyUrl)
    this.proxyAgent = agent
    this.dispatcher = dispatcher
    this.log.info('使用账号独立代理连接', { proxy: redactProxyUrl(proxyUrl ?? '') })

    // 按账号隔离设备名（Linked Devices 里各不相同，避免多账号被关联）
    const browser = deviceIdentity(this.getFingerprintSeed() || this.accountId, this.getDeviceLabel())
    this.log.debug('设备标识', { browser })

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.waLogger)
      },
      agent,
      // Baileys v7 的媒体 fetch 实际要求 undici Dispatcher，声明仍沿用 node Agent。
      fetchAgent: dispatcher as unknown as Agent,
      logger: this.waLogger,
      browser,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // 对端因解密失败请求重发时，从最近发送缓存取回消息内容
      getMessage: async (key) => {
        return (this.sentCache.get(key.id ?? '') ?? undefined) as never
      }
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.log.info('收到登录二维码，等待扫码')
        void QRCode.toDataURL(qr, { margin: 1, width: 320 }).then(
          (dataUrl) => this.setState('waiting_qr', { qrDataUrl: dataUrl }),
          (err) => this.log.error('二维码生成失败', err)
        )
      }

      if (connection === 'open') {
        this.reconnectDelay = RECONNECT_BASE_MS
        const selfName = sock.user?.name || sock.user?.id
        // JID 形如 8613800138000:12@s.whatsapp.net，冒号前即国际格式手机号
        const selfHandle = sock.user?.id?.split(':')[0]?.split('@')[0]
        this.setState('connected', { selfName, selfHandle })
        this.log.info('连接成功', { user: sock.user?.id })
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode
        this.log.warn('连接关闭', { statusCode })

        if (statusCode === DisconnectReason.loggedOut) {
          this.setState('logged_out', { detail: '账号已在其他设备退出登录' })
        } else if (this.stopping) {
          this.setState('stopped')
        } else {
          this.setState('connecting', { detail: '连接断开，正在重连…' })
          this.scheduleReconnect()
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.log.debug('messages.upsert', {
        type,
        count: messages.length,
        items: messages.map((m) => ({
          jid: m.key?.remoteJid,
          jidAlt: (m.key as { remoteJidAlt?: string }).remoteJidAlt,
          participant: m.key?.participant,
          fromMe: m.key?.fromMe,
          id: m.key?.id,
          pushName: m.pushName,
          stub: (m as { messageStubType?: number }).messageStubType,
          contentKeys: m.message ? Object.keys(m.message) : null
        }))
      })
      for (const raw of messages) {
        const stub = (raw as { messageStubType?: number }).messageStubType
        if (!raw.message && stub) {
          // 解密失败/系统占位消息：记录下来便于排障（Baileys 会自动发起重试）
          this.log.warn('收到无法解析的消息（可能解密失败，等待对端重发）', {
            jid: raw.key?.remoteJid,
            id: raw.key?.id,
            stubType: stub
          })
          continue
        }
        const mapped = mapWaMessage(raw as unknown as WaRawMessage, this.accountId)
        if (!mapped) continue
        this.emit('message', mapped)
        if (mapped.body.type === 'media') {
          void this.downloadIncomingMedia(raw, mapped)
        }
      }
    })

    // 联系人/会话元数据 → 修正会话标题（upsert 与 update 都要接）
    const emitContacts = (
      contacts: Array<{ id?: string | null; name?: string | null; notify?: string | null }>
    ): void => {
      for (const c of contacts) {
        const title = c.name || c.notify
        if (c.id && title && !isGroupJid(c.id)) {
          this.emit('conversation', { externalChatId: c.id, title, isGroup: false })
        }
      }
    }
    const emitChats = (
      chats: Array<{ id?: string | null; name?: string | null }>
    ): void => {
      for (const c of chats) {
        if (!c.id) continue
        this.emit('conversation', {
          externalChatId: c.id,
          title: c.name ?? undefined,
          isGroup: isGroupJid(c.id)
        })
      }
    }

    sock.ev.on('contacts.upsert', emitContacts)
    sock.ev.on('contacts.update', (updates) => emitContacts(updates as never))
    sock.ev.on('chats.upsert', emitChats)
    // 配对后的初始同步：通讯录与历史会话名从这里来
    sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
      this.log.info('收到历史同步', { contacts: contacts?.length ?? 0, chats: chats?.length ?? 0 })
      if (contacts) emitContacts(contacts)
      if (chats) emitChats(chats as never)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.log.info(`将在 ${Math.round(delay / 1000)}s 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((err) => {
        this.log.error('重连失败', err)
        this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectDelay = RECONNECT_BASE_MS
  }

  private requiredDispatcher(): Dispatcher {
    if (!this.dispatcher) throw new Error('代理链路已断开，安全隔离已阻止直连')
    return this.dispatcher
  }

  private async closeProxyResources(): Promise<void> {
    const dispatcher = this.dispatcher
    this.dispatcher = undefined
    if (dispatcher) await dispatcher.close().catch(() => undefined)
    this.proxyAgent?.destroy()
    this.proxyAgent = undefined
  }

  /**
   * 手机号登录（配对码方式，替代扫码）：传入手机号，向 WhatsApp 申请一个 8 位配对码，
   * 用户在手机 App「已关联的设备 → 用手机号码关联」里输入该码即可完成登录。
   * 适用于不方便扫码的场景（远程管理、批量开号）。
   */
  override async submitAuthInput(value: string): Promise<void> {
    const sock = this.sock
    if (!sock) throw new Error('WhatsApp 尚未启动，无法申请配对码')
    if (sock.authState.creds.registered) throw new Error('该账号已登录，无需配对码')

    // 只保留数字（Baileys 要求纯数字国际号码，不带 + 和空格）
    const phone = value.replace(/[^\d]/g, '')
    if (phone.length < 8) throw new Error('手机号格式不正确，请填含国家码的完整号码')

    try {
      const code = await sock.requestPairingCode(phone)
      this.log.info('已生成配对码', { phone: `***${phone.slice(-4)}` })
      this.setState('waiting_pairing_code', { pairingCode: code })
    } catch (err) {
      this.log.error('申请配对码失败', err)
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  private setState(
    status: ChannelStatus,
    extra: {
      detail?: string
      qrDataUrl?: string
      selfName?: string
      selfHandle?: string
      pairingCode?: string
    } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

/** OutboundMedia → Baileys 发送内容 */
function toWaMediaContent(media: OutboundMedia): AnyMessageContent {
  const source = { url: media.filePath }
  switch (media.mediaType) {
    case 'image':
    case 'sticker':
      return { image: source, caption: media.caption }
    case 'video':
      return { video: source, caption: media.caption }
    case 'audio':
      return {
        audio: source,
        mimetype: media.mimeType,
        // 语音条：WhatsApp 用 ptt 标记区分「语音消息」与「音频文件」
        ptt: media.ptt ?? false,
        seconds: media.durationSec
      }
    case 'document':
      return { document: source, mimetype: media.mimeType, fileName: media.fileName }
  }
}
