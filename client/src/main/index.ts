import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { cpSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, net, protocol } from 'electron'
import { OMNI_EVENT_CHANNEL, type OmniEvent } from '@shared/ipc'
import type { AccountConfig } from '@shared/settings'
import { JsonContactStore } from './core/contact-store'
import { MediaStore } from './core/media-store'
import { mimeFromPath } from './core/mime'
import { SyncClient } from './sync/sync-client'
import { ClientAuth } from './auth/client-auth'
import { packagedBackendMigration } from './auth/backend-url'
import { BillingApi } from './billing/billing-api'
import { CampaignApi } from './campaigns/campaign-api'
import { AutoReplyService } from './core/auto-reply'
import { Notifier } from './core/notifier'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { whatsAppPlugin } from './channels/whatsapp'
import { telegramBotPlugin } from './channels/telegram'
import { telegramUserPlugin } from './channels/telegram-user'
import { linePlugin } from './channels/line'
import { kakaoTalkPlugin } from './channels/kakaotalk'
import { facebookPlugin, instagramPlugin } from './channels/meta'
import { tiktokPlugin } from './channels/tiktok'
import { xPlugin } from './channels/x'
import { snapchatPlugin } from './channels/snapchat'
import { ChannelRegistry } from './channels/registry'
import { channelKey } from '@shared/domain'
import { ChannelManager } from './core/channel-manager'
import { JsonMessageStore } from './core/json-message-store'
import { SettingsStore } from './core/settings-store'
import { registerIpc } from './ipc'
import { initLogging } from './logging'
import { deviceId, osInfo } from './core/device-id'
import { LogUploader, teeLogger } from './core/log-uploader'
import { installAppMenu } from './menu'
import { TranslationPipeline } from './translation/pipeline'
import { PassthroughTranslator } from './translation/passthrough-translator'
import { configurePipeline, createTranslatorRegistry } from './translation/plugins'
import { ConfigSync } from './sync/config-sync-service'
import { AccountEnvironmentSync } from './sync/account-environment-sync'
import { AppTray } from './core/tray'
import { AppUpdater, type UpdateState } from './core/updater'
import { createMainWindow } from './window'
import { brand } from '@shared/branding'
import {
  createAccountFingerprint,
  ensureAccountFingerprint
} from './core/account-fingerprint'
import { AccountNetworkIsolation } from './core/network-isolation'
import {
  closeIsolatedOAuthWindows,
  openIsolatedOAuthWindow
} from './core/isolated-oauth-window'

// 本地媒体协议：omni-media://local/<mediaId>（必须在 ready 前注册特权）
protocol.registerSchemesAsPrivileged([
  { scheme: 'omni-media', privileges: { stream: true, supportFetchAPI: true } }
])

// 账号登录窗口只能走 fixed proxy；关闭 QUIC/非代理 UDP，避免代理断线后出现旁路流量。
app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.commandLine.appendSwitch('webrtc-hide-local-ips-with-mdns')

/**
 * 按 mediaId 扩展名推断 Content-Type —— 缺了它 <video>/<img> 会黑屏/不显示。
 * 复用 core/mime 的单一映射表（覆盖比手写更全：.mkv/.avi/.3gp 等）；
 * 无法识别（octet-stream）时返回 undefined，让协议层跳过显式 MIME、交给浏览器嗅探。
 */
function mediaMimeType(mediaId: string): string | undefined {
  const mime = mimeFromPath(mediaId)
  return mime === 'application/octet-stream' ? undefined : mime
}

type UserDataResolution = {
  path: string
  migratedLegacy: boolean
}

/**
 * 品牌升级必须在 requestSingleInstanceLock() 之前处理。Electron 会在申请单实例锁时
 * 提前创建新品牌目录；如果迁移放在其后，旧账号、Cookie 和消息就不会进入新目录。
 */
function resolveBrandUserData(): UserDataResolution {
  app.setName(brand.appName)
  const explicitUserData = process.env.OMNI_USER_DATA
  if (explicitUserData) return { path: explicitUserData, migratedLegacy: false }

  const appData = app.getPath('appData')
  const brandedUserData = join(appData, brand.appName || 'WzzScrm')
  const legacyUserData = join(appData, 'OmniChat')
  const migrationMarker = join(brandedUserData, '.wzzscrm-migrated-from-omnichat')
  if (brandedUserData === legacyUserData || !existsSync(legacyUserData) || existsSync(migrationMarker)) {
    return { path: brandedUserData, migratedLegacy: false }
  }

  try {
    if (!existsSync(brandedUserData)) {
      renameSync(legacyUserData, brandedUserData)
    } else {
      // Electron/Chromium 可能已为新品牌创建空目录。覆盖复制旧资料，但跳过运行期锁文件。
      cpSync(legacyUserData, brandedUserData, {
        recursive: true,
        force: true,
        filter: (source) => {
          const name = basename(source)
          return !name.startsWith('._') && !['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].includes(name)
        }
      })
    }
    writeFileSync(migrationMarker, new Date().toISOString(), 'utf8')
    return { path: brandedUserData, migratedLegacy: true }
  } catch {
    // 迁移失败时直接使用旧目录，数据可用性优先于目录名称。
    return { path: legacyUserData, migratedLegacy: false }
  }
}

const userDataResolution = resolveBrandUserData()
app.setPath('userData', userDataResolution.path)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void bootstrap(userDataResolution.migratedLegacy)
}

async function bootstrap(migratedLegacyUserData: boolean): Promise<void> {
  await app.whenReady()

  const userData = app.getPath('userData')
  const baseLogger = initLogging(join(userData, 'logs'))

  // 开发模式 Dock 图标：打包版由 electron-builder 的 icns/ico 接管，
  // 未打包时手动指到品牌图标（缺失就保持 Electron 默认，不报错）
  if (!app.isPackaged && process.platform === 'darwin') {
    const devIcon = join(app.getAppPath(), '..', 'branding', process.env.BRAND || 'default', 'icon.png')
    try {
      app.dock?.setIcon(devIcon)
    } catch {
      /* 图标缺失或格式不对：忽略 */
    }
  }

  const settings = new SettingsStore(userData)
  await settings.init()

  // 升级旧账号：把此前由 accountId 隐式派生的身份写成显式配置，保持旧设备标识稳定。
  const fingerprintPatch: Record<string, ReturnType<typeof settings.accountConfig>> = {}
  for (const [key, config] of Object.entries(settings.get().accounts)) {
    if (!config.fingerprint) fingerprintPatch[key] = ensureAccountFingerprint(key, config)
  }
  if (Object.keys(fingerprintPatch).length > 0) {
    await settings.update({ accounts: fingerprintPatch })
  }

  // 用户曾运行本地开发版后再安装正式包时，不能继续把工单、同步和计费请求发往
  // localhost。保留原令牌并切到品牌主库；若令牌确已失效，ClientAuth 的 401 流程
  // 会安全退出并要求重新登录。
  const currentSync = settings.get().sync
  const migratedBackend = packagedBackendMigration(
    currentSync.serverUrl,
    brand.apiUrl,
    app.isPackaged
  )
  if (migratedBackend) {
    await settings.update({ sync: { ...currentSync, serverUrl: migratedBackend } })
  }

  // 日志上报（M19）：本地 pino 之外的第二条通路。登录前也上报（游客日志，
  // 设备指纹归拢）；门槛默认 warn，管理后台可按用户调整。
  const logUploader = new LogUploader({
    getConfig: () => {
      const sync = settings.get().sync
      return { serverUrl: sync.serverUrl, token: sync.token }
    },
    deviceId: deviceId(),
    appVersion: app.getVersion(),
    ...osInfo()
  })
  logUploader.start()
  app.on('before-quit', () => {
    logUploader.stop()
    void logUploader.flush()
  })
  const logger = teeLogger(baseLogger, logUploader)
  logger.info(`${brand.appName} 启动`, { version: app.getVersion(), userData })
  if (migratedLegacyUserData) logger.info('旧品牌本地数据已迁移到 WzzScrm 数据目录')
  if (migratedBackend) {
    logger.info('已把开发后台地址迁移到正式品牌后台', { serverUrl: migratedBackend })
  }

  const store = new JsonMessageStore(join(userData, 'data'))
  await store.init()

  const media = new MediaStore(join(userData, 'media'))
  await media.init()

  const contacts = new JsonContactStore(join(userData, 'data'))
  await contacts.init()

  const mediaLog = logger.child('media')
  protocol.handle('omni-media', async (request) => {
    const mediaId = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    const abs = media.resolvePath(mediaId)
    if (!abs) {
      // 路径穿越/非法 id 或文件不在库里 —— 视频/图片会因此黑屏，这里必须留痕
      mediaLog.warn('omni-media 解析失败（非法 id 或不在媒体库）', { mediaId })
      return new Response('not found', { status: 404 })
    }
    try {
      const res = await net.fetch(pathToFileURL(abs).toString())
      // 关键：按扩展名显式补 Content-Type。file:// 取回的响应常缺/错 MIME，
      // <video>/<img> 拿不到正确类型就黑屏（尤其扩展名是 .bin 或缺失的历史文件）。
      const type = mediaMimeType(mediaId)
      const headers = new Headers(res.headers)
      if (type) headers.set('content-type', type)
      const finalType = headers.get('content-type') ?? '(none)'
      if (!type && !res.headers.get('content-type')) {
        mediaLog.warn('omni-media 无法判定 MIME（扩展名缺失/未知），可能导致黑屏', { mediaId, abs })
      } else {
        mediaLog.debug('omni-media 提供文件', { mediaId, contentType: finalType, status: res.status })
      }
      return new Response(res.body, { status: res.status, headers })
    } catch (err) {
      mediaLog.warn('omni-media 读取文件失败', { mediaId, abs, err: String(err) })
      return new Response('read error', { status: 500 })
    }
  })

  const billingApi = new BillingApi(() => settings.get().sync, logger)
  const translatorRegistry = createTranslatorRegistry()
  const pipeline = new TranslationPipeline(new PassthroughTranslator())
  pipeline.setUsageRecorder(async (usage) => {
    await billingApi.chargeTranslation(usage)
  })
  const pipelineExtras = {
    getBackend: () => ({
      serverUrl: settings.get().sync.serverUrl,
      token: settings.get().sync.token
    })
  }
  configurePipeline(pipeline, translatorRegistry, settings.get().translation, pipelineExtras)

  let requestCloudSync = (): void => {}
  let markConversationForSync = (_conversationId: string): void => {}
  const broadcast = (evt: OmniEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(OMNI_EVENT_CHANNEL, evt)
    }
    if (evt.type === 'message:new' || evt.type === 'message:updated' || evt.type === 'conversation:updated') {
      requestCloudSync()
    }
  }

  const notifier = new Notifier({
    getConfig: () => settings.get().notifications,
    logger,
    onActivate: (conversationId) => broadcast({ type: 'conversation:open', conversationId })
  })

  const autoReply = new AutoReplyService({
    getConfig: () => settings.get().autoReply,
    getMessages: (id) => store.listMessages(id, 50),
    generate: (body) => billingApi.reply(body),
    // prepared 跳过出站翻译：模型已按客户语言作答，再翻一次只会翻坏
    send: async (conversationId, text) => {
      await manager.sendText(
        conversationId,
        text,
        { send: text, original: text, targetLang: '' },
        'autoreply'
      )
    },
    claim: async (message) => {
      const stableId = message.externalId ?? message.id
      return syncClient.claim('auto-reply', `${message.conversationId}:${stableId}`)
    },
    // 客户喊人工：关掉该会话的自动回复并广播，界面开关同步熄灭
    pauseConversation: async (conversationId) => {
      const updated = await store.patchConversation({ id: conversationId, autoReply: false })
      if (updated) {
        markConversationForSync(conversationId)
        broadcast({ type: 'conversation:updated', conversation: updated })
      }
    },
    notifyHandoff: (conversation) => {
      notifier.notifyInbound(
        {
          id: 'handoff',
          conversationId: conversation.id,
          channel: conversation.channel,
          accountId: conversation.accountId,
          direction: 'in',
          body: { type: 'text', text: '客户要求人工服务，自动回复已停用' },
          timestamp: Date.now(),
          status: 'delivered'
        },
        conversation
      )
    },
    log: logger.child('auto-reply')
  })

  /** 收到入站消息时弹系统通知（窗口已聚焦则跳过，通知里带账号备注名） */
  const notifyOnInbound = (evt: OmniEvent): void => {
    if (evt.type !== 'message:new' || evt.message.direction !== 'in') return
    const key = `${evt.message.channel}:${evt.message.accountId}`
    notifier.notifyInbound(evt.message, evt.conversation, settings.accountConfig(key).label)
    void autoReply.onInbound(evt.message, evt.conversation)
  }

  const manager = new ChannelManager(
    store,
    pipeline,
    (evt) => {
      if (evt.type === 'conversation:updated') markConversationForSync(evt.conversation.id)
      broadcast(evt)
      notifyOnInbound(evt)
    },
    logger.child('manager'),
    media,
    contacts
  )
  // 出站翻译目标语言的账号级/全局默认（会话级优先逻辑在 ChannelManager 内）
  manager.getLangDefaults = (key) => ({
    accountDefault: settings.accountConfig(key).defaultLang,
    globalDefault: settings.get().translation.targetLangDefault
  })

  const networkIsolation = new AccountNetworkIsolation({
    getAccountConfig: (key) => settings.get().accounts[key],
    getBackend: () => {
      const sync = settings.get().sync
      return { url: sync.serverUrl, token: sync.token }
    },
    onState: (state) => broadcast({ type: 'network:state', state }),
    logger
  })
  const environmentSync = new AccountEnvironmentSync(
    settings,
    userData,
    (key, detail) => {
      logger.warn(detail, { key })
      void manager.stop(key).catch((error) => {
        logger.warn('停止已被其它电脑接管的账号失败', { key, error: String(error) })
      })
    },
    logger
  )
  await environmentSync.init()
  manager.setNetworkPolicy({
    assertReady: async (key) => {
      await environmentSync.acquire(key)
      try {
        return await networkIsolation.assertReady(key)
      } catch (error) {
        await environmentSync.release(key)
        throw error
      }
    },
    isUsable: (key) => environmentSync.isUsable(key) && networkIsolation.isUsable(key),
    startMonitoring: (key, onUnavailable) =>
      networkIsolation.startMonitoring(key, onUnavailable),
    stopMonitoring: (key) => networkIsolation.stopMonitoring(key),
    release: (key) => void environmentSync.release(key)
  })

  // ── 渠道插件装配。新增平台：注册插件即可（下面按 kind 通用创建适配器）──
  const channels = new ChannelRegistry()
  channels.register(whatsAppPlugin)
  channels.register(telegramUserPlugin)
  channels.register(telegramBotPlugin)
  channels.register(linePlugin)
  channels.register(kakaoTalkPlugin)
  channels.register(facebookPlugin)
  channels.register(instagramPlugin)
  channels.register(tiktokPlugin)
  channels.register(xPlugin)
  channels.register(snapchatPlugin)

  const registerAccount = (kind: string, accountId: string): void => {
    const plugin = channels.get(kind as never)
    const key = `${kind}:${accountId}`
    manager.register(
      plugin.createAdapter(accountId, {
        dataDir: join(userData, 'channels', kind),
        logger,
        getAccountConfig: () => {
          const cfg = settings.accountConfig(key)
          return {
            proxyUrl: cfg.proxyUrl,
            deviceLabel: cfg.deviceLabel,
            fingerprint: cfg.fingerprint,
            credentials: cfg.credentials
          }
        },
        saveMedia: (data, ext) => media.save(data, ext),
        getBackend: () => {
          const s = settings.get().sync
          return { url: s.serverUrl, token: s.token }
        },
        saveCredentials: async (credentials) => {
          await settings.replaceAccountCredentials(key, credentials)
          environmentSync.scheduleUpload(key)
        },
        notifyEnvironmentChanged: () => environmentSync.scheduleUpload(key),
        getDefaults: () => {
          const p = settings.get().platform
          return { telegramApiId: p.telegramApiId, telegramApiHash: p.telegramApiHash }
        },
        openOAuth: async (url) => {
          const config = settings.accountConfig(key)
          if (!config.proxyUrl || !config.fingerprint) {
            throw new Error('必须先配置代理与设备指纹，才能打开网页登录')
          }
          await openIsolatedOAuthWindow({
            accountKey: key,
            url,
            proxyUrl: config.proxyUrl,
            fingerprint: config.fingerprint
          })
        }
      })
    )
  }

  // 账号注册表 = settings.accounts 的 key 集合；空列表表示尚未添加账号。
  // 禁用账号仍注册适配器（保留账号与登录凭证），但启动时跳过连接。
  const accountConfigs = settings.get().accounts
  for (const key of Object.keys(accountConfigs)) {
    const sep = key.indexOf(':')
    const kind = key.slice(0, sep)
    const accountId = key.slice(sep + 1)
    if (accountId && channels.has(kind as never)) {
      registerAccount(kind, accountId)
      if (accountConfigs[key]?.disabled) manager.setDisabled(key, true)
    }
  }

  /**
   * Meta 令牌在服务器，因此同一老板/团队换电脑登录后可恢复账号注册表。
   * 接口只返回 Page / Instagram 的公开摘要，不会把 token 或 App Secret 下发到桌面端。
   */
  const restoreServerMetaAccounts = async (): Promise<void> => {
    const sync = settings.get().sync
    if (!sync.serverUrl || !sync.token) return
    try {
      const response = await fetch(`${sync.serverUrl.replace(/\/$/, '')}/api/meta/accounts`, {
        headers: { authorization: `Bearer ${sync.token}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        accounts?: Array<{ channel?: string; accountId?: string; displayName?: string }>
      }
      const remote = (data.accounts ?? []).flatMap((account) => {
        if (
          account.channel !== 'facebook' && account.channel !== 'instagram' ||
          typeof account.accountId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(account.accountId)
        ) return []
        return [{
          channel: account.channel,
          accountId: account.accountId,
          displayName: account.displayName
        }]
      })

      const current = settings.get().accounts
      const missing: Record<string, AccountConfig> = {}
      for (const account of remote) {
        const key = `${account.channel}:${account.accountId}`
        if (!current[key]) {
          missing[key] = {
            label: account.displayName || undefined,
            fingerprint: createAccountFingerprint(key)
          }
        }
      }
      if (Object.keys(missing).length > 0) await settings.update({ accounts: missing })

      const registered = new Set(manager.listChannels().map((state) => `${state.kind}:${state.accountId}`))
      const latest = settings.get().accounts
      for (const account of remote) {
        const key = `${account.channel}:${account.accountId}`
        if (!registered.has(key)) {
          registerAccount(account.channel, account.accountId)
          registered.add(key)
        }
        if (!latest[key]?.disabled) await manager.start(key)
      }
      if (remote.length > 0) logger.info('已恢复服务器 Meta 账号', { count: remote.length })
    } catch (error) {
      logger.warn('恢复服务器 Meta 账号失败，将在下次登录或启动时重试', { error: String(error) })
    }
  }

  /** TikTok 令牌同样归服务器保管；登录同一团队时恢复企业号注册表。 */
  const restoreServerTikTokAccounts = async (): Promise<void> => {
    const sync = settings.get().sync
    if (!sync.serverUrl || !sync.token) return
    try {
      const response = await fetch(`${sync.serverUrl.replace(/\/$/, '')}/api/tiktok/accounts`, {
        headers: { authorization: `Bearer ${sync.token}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        accounts?: Array<{ channel?: string; accountId?: string; displayName?: string }>
      }
      const remote = (data.accounts ?? []).flatMap((account) => {
        if (
          account.channel !== 'tiktok' ||
          typeof account.accountId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(account.accountId)
        ) return []
        return [{ accountId: account.accountId, displayName: account.displayName }]
      })

      const current = settings.get().accounts
      const missing: Record<string, AccountConfig> = {}
      for (const account of remote) {
        const key = `tiktok:${account.accountId}`
        if (!current[key]) {
          missing[key] = {
            label: account.displayName || undefined,
            fingerprint: createAccountFingerprint(key)
          }
        }
      }
      if (Object.keys(missing).length > 0) await settings.update({ accounts: missing })

      const registered = new Set(manager.listChannels().map((state) => `${state.kind}:${state.accountId}`))
      const latest = settings.get().accounts
      for (const account of remote) {
        const key = `tiktok:${account.accountId}`
        if (!registered.has(key)) {
          registerAccount('tiktok', account.accountId)
          registered.add(key)
        }
        if (!latest[key]?.disabled) await manager.start(key)
      }
      if (remote.length > 0) logger.info('已恢复服务器 TikTok 账号', { count: remote.length })
    } catch (error) {
      logger.warn('恢复服务器 TikTok 账号失败，将在下次登录或启动时重试', { error: String(error) })
    }
  }

  /** X / Snapchat 令牌与会话都由服务器托管，换电脑登录同一团队后自动恢复。 */
  const restoreServerManagedAccounts = async (channel: 'x' | 'snapchat'): Promise<void> => {
    const sync = settings.get().sync
    if (!sync.serverUrl || !sync.token) return
    try {
      const response = await fetch(`${sync.serverUrl.replace(/\/$/, '')}/api/${channel}/accounts`, {
        headers: { authorization: `Bearer ${sync.token}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        accounts?: Array<{ channel?: string; accountId?: string; displayName?: string }>
      }
      const remote = (data.accounts ?? []).flatMap((account) => {
        if (
          account.channel !== channel || typeof account.accountId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(account.accountId)
        ) return []
        return [{ accountId: account.accountId, displayName: account.displayName }]
      })
      const current = settings.get().accounts
      const missing: Record<string, AccountConfig> = {}
      for (const account of remote) {
        const key = `${channel}:${account.accountId}`
        if (!current[key]) {
          missing[key] = {
            label: account.displayName || undefined,
            fingerprint: createAccountFingerprint(key)
          }
        }
      }
      if (Object.keys(missing).length > 0) await settings.update({ accounts: missing })

      const registered = new Set(manager.listChannels().map((state) => `${state.kind}:${state.accountId}`))
      const latest = settings.get().accounts
      for (const account of remote) {
        const key = `${channel}:${account.accountId}`
        if (!registered.has(key)) {
          registerAccount(channel, account.accountId)
          registered.add(key)
        }
        if (!latest[key]?.disabled) await manager.start(key)
      }
      if (remote.length > 0) logger.info(`已恢复服务器 ${channel} 账号`, { count: remote.length })
    } catch (error) {
      logger.warn(`恢复服务器 ${channel} 账号失败，将在下次登录或启动时重试`, { error: String(error) })
    }
  }

  const restoreServerOauthAccounts = async (): Promise<void> => {
    await Promise.all([
      restoreServerMetaAccounts(),
      restoreServerTikTokAccounts(),
      restoreServerManagedAccounts('x'),
      restoreServerManagedAccounts('snapchat')
    ])
  }

  /** 云端账号目录发生变化后，让运行中的适配器集合与本机注册表一致。 */
  const reconcileAccountRegistry = async (updated = settings.get()): Promise<void> => {
    const configured = new Set(Object.keys(updated.accounts))
    const states = manager.listChannels()
    for (const state of states) {
      const key = `${state.kind}:${state.accountId}`
      if (!configured.has(key)) await manager.unregister(key)
    }
    const registered = new Set(manager.listChannels().map((state) => `${state.kind}:${state.accountId}`))
    for (const [key, account] of Object.entries(updated.accounts)) {
      if (!registered.has(key)) {
        const separator = key.indexOf(':')
        const kind = key.slice(0, separator)
        const accountId = key.slice(separator + 1)
        if (separator <= 0 || !accountId || !channels.has(kind as never)) continue
        registerAccount(kind, accountId)
        registered.add(key)
      }
      manager.setDisabled(key, account.disabled === true)
    }
  }

  // ── 聊天记录后台同步（批量定时） ──
  const syncRecordPath = join(userData, 'data', 'sync-state.json')
  let syncRecord = { lastSyncedAt: 0, boundaryIds: [] as string[] }
  try {
    syncRecord = JSON.parse(await readFile(syncRecordPath, 'utf8'))
  } catch {
    // 首次运行
  }
  const syncClient = new SyncClient({
    store,
    media,
    getAccountProfiles: async () => {
      const states = manager.listChannels()
      // 每次同步前刷新一次自身头像；这样头像在 WhatsApp 中更新后最多一个同步周期可见。
      await Promise.all(states.map(async (state) => {
        if (state.status !== 'connected') return
        await manager.refreshSelfProfile(`${state.kind}:${state.accountId}`).catch(() => undefined)
      }))
      return manager.listChannels().map((state) => ({
        accountId: state.accountId,
        channel: state.kind,
        handle: state.selfHandle,
        avatarMediaId: state.avatarMediaId,
        status: state.status === 'connected' ? 'online' : state.status === 'error' ? 'error' : 'offline'
      }))
    },
    getConfig: () => settings.get().sync,
    initialRecord: syncRecord,
    persistRecord: async (r) => {
      await mkdir(join(userData, 'data'), { recursive: true })
      await writeFile(syncRecordPath, JSON.stringify(r), 'utf8')
    },
    // 服务端历史恢复只刷新界面，不走 ChannelManager，避免把旧消息当新消息弹通知或触发 AI 自动回复。
    onRemoteConversation: (conversation) => broadcast({ type: 'conversation:updated', conversation }),
    onRemoteMessage: (message, conversation) => broadcast({ type: 'message:new', message, conversation }),
    logger
  })
  requestCloudSync = () => syncClient.requestSoon()
  markConversationForSync = (conversationId) => {
    void syncClient.markConversationDirty(conversationId)
  }
  syncClient.start()

  const auth = new ClientAuth(settings, logger)
  // 普通设置只同步非敏感白名单；平台登录态由单独的加密环境服务同步。
  const configSync = new ConfigSync(settings, {
    logger,
    onApplied: (updated) => {
      configurePipeline(pipeline, translatorRegistry, updated.translation, pipelineExtras)
      void reconcileAccountRegistry(updated)
    }
  })
  configSync.start()
  // 工单数据落后台（看板要能被团队公开访问），复用同步配置里的地址与登录令牌
  const campaignApi = new CampaignApi(() => settings.get().sync, logger)

  // 自动更新：更新源 = 后台地址 + /updates；未登录后台时禁用
  const updater = new AppUpdater({
    feedUrl: () => {
      const url = settings.get().sync.serverUrl
      return url ? `${url.replace(/\/$/, '')}/updates` : ''
    },
    onState: (state) => broadcast({ type: 'update:state', state }),
    logger
  })
  void updater.start()

  const tray = new AppTray({
    getWindow: () => BrowserWindow.getAllWindows()[0],
    checkUpdates: () => void updater.checkNow(),
    version: app.getVersion()
  })
  tray.create()
  // 未读数同步到托盘 tooltip 与菜单
  const origSetUnread = notifier.setUnreadTotal.bind(notifier)
  notifier.setUnreadTotal = (total) => {
    origSetUnread(total)
    tray.setUnread(total)
  }


  registerIpc({
    manager,
    store,
    settings,
    auth,
    channels,
    translators: translatorRegistry,
    campaigns: campaignApi,
    billingApi,
    media,
    notifier,
    updater,
    configSync,
    syncClient,
    networkIsolation,
    version: app.getVersion(),
    broadcast,
    onSettingsChanged: (updated) => {
      configurePipeline(pipeline, translatorRegistry, updated.translation, pipelineExtras)
      environmentSync.scheduleAll(updated)
      logger.info('设置已更新')
    },
    onAddAccount: async (channel) => {
      if (!channels.has(channel as never)) throw new Error(`暂不支持添加 ${channel} 账号`)
      const accountId = `${channel.slice(0, 2)}${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const key = channelKey(channel as never, accountId)
      await settings.update({
        accounts: { [key]: { fingerprint: createAccountFingerprint(key) } }
      })
      registerAccount(channel, accountId)
      // 任何平台都必须先由账号设置完成代理检测，不能在无隔离环境下提前发起登录。
      logger.info('新增账号', { key })
      configSync.pushDebounced()
      return key
    },
    onRemoveAccount: async (key) => {
      const separator = key.indexOf(':')
      const channel = separator > 0 ? key.slice(0, separator) : 'unknown'
      const accountId = separator > 0 ? key.slice(separator + 1) : key
      await campaignApi.markAccountRemoved(accountId, channel).catch((error) => {
        logger.warn('账号删除后标记工单账号失败', { key, error: String(error) })
      })
      await manager.logout(key).catch(() => undefined)
      await manager.unregister(key)
      await environmentSync.remove(key)
      await settings.removeAccount(key)
      configSync.pushDebounced()
      logger.info('已删除账号', { key })
    },
    onAuthReady: async () => {
      // 登录前可能正在使用本机离线会话；先停下，再按新工作区逐账号取得云端环境与租约。
      await manager.stopAll()
      await reconcileAccountRegistry(settings.get())
      await restoreServerOauthAccounts()
      await manager.startAll()
    },
    onQuit: () => {
      tray.quitting = true
      app.quit()
    }
  })

  installAppMenu()
  // 恢复顺序必须固定：账号目录 → 适配器注册 → 逐账号获取加密环境与租约 → 平台连接。
  // 每个账号在 ChannelManager.start 的网络门禁中恢复，避免一次下载上百个大型会话快照。
  await configSync.pull()
  await reconcileAccountRegistry(settings.get())
  await restoreServerOauthAccounts()
  const win = createMainWindow()
  // 关窗进托盘而不是退出：客服工具要保持后台在线收消息。
  // 从托盘选"退出"或 app 正在退出时放行。
  win.on('close', (e) => {
    if (tray.quitting) return
    e.preventDefault()
    win.hide()
  })
  void manager.startAll()

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('activate', () => {
    // 关窗进托盘后窗口只是隐藏：点 Dock 图标要把它拉回来，而不是没反应
    const wins = BrowserWindow.getAllWindows()
    if (wins.length === 0) {
      createMainWindow()
      return
    }
    for (const w of wins) {
      if (w.isMinimized()) w.restore()
      w.show()
    }
    wins[0]?.focus()
  })

  app.on('window-all-closed', () => {
    // 保持后台在线收消息是这类客服工具的预期行为；macOS 关窗不退出
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // 任何路径触发退出（Cmd+Q、更新安装）都要放行 close
    tray.quitting = true
    updater.stop()
    tray.destroy()
    syncClient.stop()
    networkIsolation.stopAll()
    closeIsolatedOAuthWindows()
    void configSync.flush()
    void environmentSync.stop()
    void manager.stopAll()
    void store.flush()
  })
}
