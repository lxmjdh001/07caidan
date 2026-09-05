import { readFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { Api, TelegramClient } from 'telegram'
// GramJS 是 CJS 包且没有 exports 映射，ESM 下目录导入会被拒，必须写到具体文件
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import {
  ChannelAdapter,
  type GroupSummary,
  type OutboundMedia,
  type OutboundResult
} from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import { createRequiredSocksProxyConfig } from '../../core/proxy'
import { telegramAuthRecovery } from './auth-error'
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
const RECENT_DIALOG_LIMIT = 200
const ACTIVE_STATUSES = new Set<ChannelStatus>([
  'connecting',
  'waiting_qr',
  'waiting_phone',
  'waiting_code',
  'waiting_password',
  'connected'
])

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
  /**
   * Telegram 只凭十进制 user id 不能向 API 换取完整用户资料，必须同时持有
   * dialogs/update 返回的 access_hash。把最近会话实体缓存下来，昵称、公开用户名、
   * 头像和发送消息都复用同一个真实实体，不能拿内部数字 ID 冒充资料。
   */
  private readonly entities = new Map<string, TgEntity>()
  private readonly entityLookups = new Map<string, Promise<TgEntity | undefined>>()
  private profileLoad: Promise<void> | undefined
  /**
   * 每次 start/stop 都推进代次。异步登录任务结束时必须仍是当前代次，
   * 否则它属于已经断开的旧连接，不得覆盖新登录流程的状态。
   */
  private loginRun = 0

  constructor(opts: TelegramUserAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.opts = opts
    this.log = (opts.logger ?? noopLogger).child(`telegram:${opts.accountId}`)
  }

  async start(): Promise<void> {
    // startAll、账号点击和手动刷新可能几乎同时触发；同一登录流程只允许一个实例。
    if (ACTIVE_STATUSES.has(this.status)) return
    const run = ++this.loginRun
    this.stopping = false
    const isCurrentRun = (): boolean => run === this.loginRun && !this.stopping
    const { apiId, apiHash } = this.opts.getApiCredentials()
    if (!apiId || !apiHash) {
      // 正常情况下走内置凭证，不该到这里；说明这个版本打包时没注入 OMNI_TG_API_ID
      this.setState('need_credentials', {
        detail: '本版本未内置 Telegram 应用凭证，请在全局设置或账号高级设置里填写 API ID / API Hash'
      })
      return
    }

    this.setState('connecting')
    let client: TelegramClient | undefined
    let authError: Error | undefined
    let nextPromptDetail: string | undefined
    try {
      // error 状态重试时先清理上一次失败留下的客户端，避免复用断开的 sender。
      const previousClient = this.client
      this.client = undefined
      if (previousClient) {
        try {
          await previousClient.disconnect()
        } catch {
          // 旧连接本来就可能已经断开
        }
      }
      if (!isCurrentRun()) return

      const session = new StringSession(this.opts.getSession() ?? '')
      const proxy = createRequiredSocksProxyConfig(this.opts.getProxyUrl?.())
      const fp = this.opts.getDeviceFingerprint?.()
      if (proxy) this.log.info('使用代理连接', { ip: proxy.ip, port: proxy.port })

      client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        // 多账号防关联：各账号上报不同设备标识
        deviceModel: fp?.deviceModel,
        systemVersion: fp?.systemVersion,
        appVersion: fp?.appVersion,
        proxy
      })
      this.client = client

      const password = async (hint?: string): Promise<string> => {
        if (!isCurrentRun()) throw new Error('登录流程已更新')
        const retryDetail = nextPromptDetail
        nextPromptDetail = undefined
        this.setState('waiting_password', {
          detail: retryDetail || (this.loginMode === 'qr'
            ? hint
              ? `二维码已确认。请输入 Telegram 两步验证密码（提示：${hint}）`
              : '二维码已确认。Telegram 要求此账号继续完成两步验证。'
            : hint
              ? `两步验证密码（提示：${hint}）`
              : '请输入两步验证密码')
        })
        return this.awaitInput()
      }
      const onError = async (err: Error): Promise<boolean> => {
        if (!isCurrentRun()) return true
        const recovery = telegramAuthRecovery(err)
        if (recovery.retry) {
          authError = undefined
          nextPromptDetail = recovery.detail
          if (recovery.step === 'phone') this.phone = ''
          this.log.warn('登录输入未通过验证，等待重新输入', {
            step: recovery.step,
            error: (err as Error & { errorMessage?: string }).errorMessage || err.message
          })
          return false
        }
        authError = err
        if (recovery.detail) authError = new Error(recovery.detail)
        this.log.error('登录失败', err)
        // 返回 true 终止登录流程，避免 GramJS 无限重试
        return true
      }

      await client.connect()
      if (!isCurrentRun()) return
      if (await client.checkAuthorization()) {
        this.log.info('已有会话，免登录')
      } else if (this.loginMode === 'qr') {
        // 扫码登录：GramJS 会自动续期令牌并反复回调，这里每次重画二维码
        await client.signInUserWithQrCode(
          { apiId, apiHash },
          {
            qrCode: async (qr) => {
              if (!isCurrentRun()) return
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
            if (!isCurrentRun()) throw new Error('登录流程已更新')
            if (this.phone) return this.phone
            const retryDetail = nextPromptDetail
            nextPromptDetail = undefined
            this.setState('waiting_phone', {
              detail: retryDetail || '请输入该账号的手机号（含国家码）'
            })
            this.phone = await this.awaitInput()
            return this.phone
          },
          phoneCode: async (isCodeViaApp?: boolean) => {
            if (!isCurrentRun()) throw new Error('登录流程已更新')
            const retryDetail = nextPromptDetail
            nextPromptDetail = undefined
            this.setState('waiting_code', {
              detail: retryDetail || (isCodeViaApp
                ? '验证码已发送到 Telegram 应用内'
                : '验证码已通过 Telegram 指定方式发送')
            })
            return this.awaitInput()
          },
          password,
          onError
        })
      }

      if (!isCurrentRun()) return

      // GramJS 返回后再向 Telegram 查询一次真实授权态。只有服务端确认授权完成，
      // 才保存会话并向 UI 发布 connected，避免任何中间步骤被误报为登录成功。
      if (!(await client.checkAuthorization())) {
        throw new Error('Telegram 授权尚未完成，请继续完成手机确认或两步验证')
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

      // 优先用户名（t.me/xxx 链接要用它），没有设置用户名时退回手机号
      const selfHandle = (me as Api.User).username || this.phone || undefined
      if (!isCurrentRun()) return
      // 新 StringSession 的实体缓存是空的。先启动 dialogs 预取，再发布 connected；
      // ChannelManager 随后的资料补全会等待同一个 Promise，不会因 access_hash 缺失而失败。
      this.entities.clear()
      this.entityLookups.clear()
      this.profileLoad = this.loadRecentDialogProfiles(client)
      this.setState('connected', { selfName, selfHandle })
      void this.profileLoad.catch((err) => {
        if (this.client === client) this.log.debug('预取 Telegram 会话资料失败', { err: String(err) })
      })
      this.log.info('连接成功', { user: this.selfId })
    } catch (err) {
      if (!isCurrentRun()) return
      const failure = authError ?? (err instanceof Error ? err : new Error(String(err)))
      this.log.error('启动失败', failure)
      if (this.client === client) this.client = undefined
      try {
        await client?.disconnect()
      } catch {
        // 失败连接清理不应覆盖原始错误
      }
      this.setState('error', { detail: failure.message })
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
    ++this.loginRun
    this.rejectPending('已停止')
    const client = this.client
    try {
      await client?.disconnect()
    } catch {
      // 断开失败不影响停止
    }
    if (this.client === client) this.client = undefined
    this.profileLoad = undefined
    this.entities.clear()
    this.entityLookups.clear()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    this.stopping = true
    ++this.loginRun
    this.rejectPending('已退出登录')
    const client = this.client
    try {
      await client?.invoke(new Api.auth.LogOut())
    } catch (err) {
      this.log.warn('注销请求失败，仍清除本地会话', { err: String(err) })
    }
    try {
      await client?.disconnect()
    } catch {
      // 忽略
    }
    if (this.client === client) this.client = undefined
    this.profileLoad = undefined
    this.entities.clear()
    this.entityLookups.clear()
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
    const entity = await this.resolveEntity(externalChatId)
    if (!entity) throw new Error('无法读取 Telegram 会话资料，请刷新账号后重试')
    const msg = await client.sendMessage(entity, { message: text })
    return { externalId: String(msg.id) }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    const client = this.requireClient()
    const entity = await this.resolveEntity(externalChatId)
    if (!entity) throw new Error('无法读取 Telegram 会话资料，请刷新账号后重试')
    const buf = await readFile(media.filePath)
    const file = new (await import('telegram/client/uploads')).CustomFile(
      media.fileName,
      buf.length,
      media.filePath,
      buf
    )
    const msg = await client.sendFile(entity, {
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
    return displayNameOf(await this.resolveEntity(externalChatId))
  }

  override async fetchPublicId(externalChatId: string): Promise<string | undefined> {
    return publicIdOf(await this.resolveEntity(externalChatId))
  }

  /**
   * 读取当前账号真正加入的 Telegram 群组。
   *
   * Telegram 的超级群与广播频道都使用 PeerChannel，不能只看 peer 类型；必须读取
   * Channel.megagroup / broadcast 才能避免把频道误标为群组。ignoreMigrated 则避免普通群
   * 升级成超级群后在列表里出现两次。
   */
  override async listGroups(): Promise<GroupSummary[]> {
    const client = this.requireClient()
    const dialogs = await client.getDialogs({ limit: undefined, ignoreMigrated: true })
    if (this.client !== client || this.status !== 'connected') {
      throw new Error('Telegram 连接已断开，无法读取群组')
    }

    const groups: GroupSummary[] = []
    for (const dialog of dialogs) {
      const entity = this.rememberEntity(dialog.entity)
      if (!entity || !isUsableTelegramGroup(entity)) continue
      groups.push({
        externalChatId: externalChatIdOf(entity),
        title: displayNameOf(entity) || '未命名群组',
        // 群组列表只需要摘要；逐群拉全体成员会在大群上产生大量请求和 FloodWait。
        participantIds: []
      })
    }
    return groups
  }

  /** 使用 Telegram 官方 messages.createChat 创建普通群组。 */
  override async createGroup(subject: string, participantIds: string[]): Promise<GroupSummary> {
    const client = this.requireClient()
    const title = subject.trim()
    if (!title) throw new Error('群组名称不能为空')

    const uniqueIds = [...new Set(participantIds.map((id) => id.trim()).filter(Boolean))]
    if (uniqueIds.length === 0) throw new Error('请至少选择一位成员')

    const resolved = await Promise.all(uniqueIds.map((id) => this.resolveEntity(id)))
    const users: Api.User[] = []
    const missing: string[] = []
    for (let index = 0; index < uniqueIds.length; index += 1) {
      const entity = resolved[index]
      if (entity instanceof Api.User && !entity.self && !entity.deleted) users.push(entity)
      else missing.push(uniqueIds[index]!)
    }
    if (missing.length > 0) {
      throw new Error(`无法读取 ${missing.length} 位成员的 Telegram 资料，请先打开对应私聊后重试`)
    }
    if (users.length === 0) throw new Error('请至少选择一位有效成员')

    const knownGroupIds = new Set(
      [...this.entities.values()]
        .filter(isUsableTelegramGroup)
        .map(externalChatIdOf)
    )
    const created = await client.invoke(new Api.messages.CreateChat({ users, title }))
    if (this.client !== client || this.status !== 'connected') {
      throw new Error('Telegram 连接已断开，群组创建结果无法确认')
    }

    const createdEntity = telegramUpdateChats(created.updates)
      .map((entity) => this.rememberEntity(entity))
      .find((entity): entity is TgEntity => !!entity && isUsableTelegramGroup(entity))
    if (!createdEntity) {
      // 正常响应会在 updates.chats 携带新群；若 SDK/协议层响应形态变化，则从真实
      // dialogs 再确认一次，绝不在本地伪造一个无法收发消息的群。
      const dialogs = await client.getDialogs({ limit: 100, ignoreMigrated: true })
      const refreshed = dialogs.map((dialog) => this.rememberEntity(dialog.entity))
      const fallback = refreshed
        .find((entity): entity is TgEntity =>
          !!entity &&
          isUsableTelegramGroup(entity) &&
          !knownGroupIds.has(externalChatIdOf(entity)) &&
          displayNameOf(entity) === title
        )
      if (!fallback) throw new Error('Telegram 已响应，但无法确认新群组，请刷新群组列表')
      return {
        externalChatId: externalChatIdOf(fallback),
        title: displayNameOf(fallback) || title,
        participantIds: uniqueIds
      }
    }

    return {
      externalChatId: externalChatIdOf(createdEntity),
      title: displayNameOf(createdEntity) || title,
      participantIds: uniqueIds
    }
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    const client = this.client
    const saveMedia = this.opts.saveMedia
    if (!client || this.status !== 'connected' || !saveMedia) return undefined
    const entity = await this.resolveEntity(externalChatId)
    if (!entity) return undefined
    try {
      const photo = await client.downloadProfilePhoto(entity, { isBig: false })
      if (!photo) return undefined
      const buffer = Buffer.isBuffer(photo) ? photo : await readFile(photo)
      if (buffer.length === 0) return undefined
      return await saveMedia(buffer, '.jpg')
    } catch (err) {
      this.log.debug('Telegram 会话头像拉取失败', { externalChatId, err: String(err) })
      return undefined
    }
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    const client = this.client
    const saveMedia = this.opts.saveMedia
    if (!client || this.status !== 'connected' || !saveMedia) return undefined
    try {
      const photo = await client.downloadProfilePhoto('me', { isBig: false })
      if (!photo) return undefined
      const buffer = Buffer.isBuffer(photo) ? photo : await readFile(photo)
      if (buffer.length === 0) return undefined
      return await saveMedia(buffer, '.jpg')
    } catch (err) {
      this.log.debug('账号头像拉取失败', { err: String(err) })
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

  /**
   * 预取最近 dialogs 的完整实体。GramJS 会同时把 input entity/access_hash 写入自身缓存，
   * 所以后续发送消息也能使用这些实体，而不是只有一个无法解析的裸 user id。
   */
  private async loadRecentDialogProfiles(client: TelegramClient): Promise<void> {
    const dialogs = await client.getDialogs({ limit: RECENT_DIALOG_LIMIT })
    if (this.client !== client) return
    for (const dialog of dialogs) this.rememberEntity(dialog.entity)
  }

  private rememberEntity(value: unknown): TgEntity | undefined {
    if (!isTgEntity(value)) return undefined
    const externalChatId = externalChatIdOf(value)
    if (!externalChatId) return undefined
    this.entities.set(externalChatId, value)
    return value
  }

  /**
   * 根据会话 ID 取得带 access_hash 的实体。首次登录时等待统一 dialogs 预取；如果是预取后
   * 才出现的新会话，再刷新一次 dialogs。相同会话的并发昵称/ID/头像请求只发一次网络请求。
   */
  private async resolveEntity(externalChatId: string): Promise<TgEntity | undefined> {
    const cached = this.entities.get(externalChatId)
    if (cached) return cached
    if (!this.client || this.status !== 'connected') return undefined

    const running = this.entityLookups.get(externalChatId)
    if (running) return running
    const client = this.client
    const lookup = (async (): Promise<TgEntity | undefined> => {
      try {
        await this.profileLoad
      } catch {
        // 预取失败仍继续做一次针对当前新会话的刷新。
      }
      const loaded = this.entities.get(externalChatId)
      if (loaded || this.client !== client) return loaded

      try {
        await this.loadRecentDialogProfiles(client)
      } catch (err) {
        this.log.debug('刷新 Telegram 会话资料失败', { externalChatId, err: String(err) })
      }
      return this.entities.get(externalChatId)
    })()
    this.entityLookups.set(externalChatId, lookup)
    try {
      return await lookup
    } finally {
      if (this.entityLookups.get(externalChatId) === lookup) {
        this.entityLookups.delete(externalChatId)
      }
    }
  }

  /** 外部会话 id → GramJS 实体标识（群带 g 前缀，需还原成负数/原 id） */
  private toEntity(externalChatId: string): string {
    return externalChatId.startsWith('g') ? externalChatId.slice(1) : externalChatId
  }

  private async handleEvent(event: NewMessageEvent): Promise<void> {
    try {
      // Updates/UpdatesCombined 会直接携带完整实体，优先收进缓存；UpdateShortMessage
      // 没带实体时 resolveEntity 会从 dialogs 获取 access_hash 和资料。
      for (const entity of event.originalUpdate?._entities?.values() ?? []) {
        this.rememberEntity(entity)
      }
      const raw = await this.toRawMessage(event)
      if (!raw) return
      const externalChatId = peerToChatId(raw.peer)
      const entity = await this.resolveEntity(externalChatId)
      if (!raw.senderName && raw.peer.type === 'user') raw.senderName = displayNameOf(entity)
      const mapped = mapTgUserMessage(raw, this.accountId)
      if (!mapped) return

      this.emit('message', mapped)
      this.emit('conversation', {
        externalChatId,
        title: displayNameOf(entity),
        publicId: publicIdOf(entity),
        contactId: chatIdToContactId(externalChatId),
        // PeerChannel 既可能是超级群也可能是单向广播频道，必须以实体属性为准。
        isGroup: entity ? isTelegramGroup(entity) : raw.peer.type === 'chat'
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
  private async toRawMessage(event: NewMessageEvent): Promise<TgRawMessage | null> {
    const m = event.message
    if (!m) return null
    const peer = toPeer(m.peerId)
    if (!peer) return null

    const senderName = await extractSenderName(event)
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
    extra: {
      detail?: string
      selfName?: string
      selfHandle?: string
      qrDataUrl?: string
    } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

type TgEntity =
  | Api.User
  | Api.Chat
  | Api.ChatForbidden
  | Api.Channel
  | Api.ChannelForbidden

function isTgEntity(value: unknown): value is TgEntity {
  return (
    value instanceof Api.User ||
    value instanceof Api.Chat ||
    value instanceof Api.ChatForbidden ||
    value instanceof Api.Channel ||
    value instanceof Api.ChannelForbidden
  )
}

/** Telegram 普通群、超级群和 gigagroup；明确排除广播频道。 */
export function isTelegramGroup(entity: TgEntity): boolean {
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) return true
  if (entity instanceof Api.Channel) return !!(entity.megagroup || entity.gigagroup) && !entity.broadcast
  if (entity instanceof Api.ChannelForbidden) return !!entity.megagroup && !entity.broadcast
  return false
}

/** 仍可正常使用的已加入群组；被踢/离开/已停用的实体不进入群组列表。 */
export function isUsableTelegramGroup(entity: TgEntity): boolean {
  if (!isTelegramGroup(entity)) return false
  if (entity instanceof Api.ChatForbidden || entity instanceof Api.ChannelForbidden) return false
  if (entity instanceof Api.Chat) return !entity.left && !entity.deactivated && !entity.migratedTo
  if (entity instanceof Api.Channel) return !entity.left
  return false
}

function externalChatIdOf(entity: TgEntity): string {
  const id = String(entity.id)
  return entity instanceof Api.User ? id : `g${id}`
}

function displayNameOf(entity: TgEntity | undefined): string | undefined {
  if (!entity) return undefined
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || undefined
  }
  return entity.title || undefined
}

function publicIdOf(entity: TgEntity | undefined): string | undefined {
  if (!(entity instanceof Api.User) && !(entity instanceof Api.Channel)) return undefined
  const username = entity.username || entity.usernames?.find((item) => item.active)?.username
  return username ? `@${username}` : undefined
}

/** Api.Peer* → mapper 的 TgPeer */
function toPeer(peerId: unknown): TgPeer | null {
  if (peerId instanceof Api.PeerUser) return { type: 'user', id: String(peerId.userId) }
  if (peerId instanceof Api.PeerChat) return { type: 'chat', id: String(peerId.chatId) }
  if (peerId instanceof Api.PeerChannel) return { type: 'channel', id: String(peerId.channelId) }
  return null
}

async function extractSenderName(event: NewMessageEvent): Promise<string | undefined> {
  const message = event.message as typeof event.message & {
    sender?: unknown
    getSender?: () => Promise<unknown>
  }
  let sender = message.sender
  if (!isTgEntity(sender) && message.getSender) {
    try {
      sender = await message.getSender()
    } catch {
      // 匿名管理员或资料受限时 Telegram 可能不给 sender；消息本身仍应正常展示。
    }
  }
  return isTgEntity(sender) ? displayNameOf(sender) : undefined
}

function telegramUpdateChats(updates: Api.TypeUpdates): unknown[] {
  if ('chats' in updates && Array.isArray(updates.chats)) return updates.chats
  return []
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
