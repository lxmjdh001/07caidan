import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol } from 'electron'
import { OMNI_EVENT_CHANNEL, type OmniEvent } from '@shared/ipc'
import { JsonContactStore } from './core/contact-store'
import { MediaStore } from './core/media-store'
import { SyncClient } from './sync/sync-client'
import { ClientAuth } from './auth/client-auth'
import { BillingApi } from './billing/billing-api'
import { CampaignApi } from './campaigns/campaign-api'
import { Notifier } from './core/notifier'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { whatsAppPlugin } from './channels/whatsapp'
import { telegramBotPlugin } from './channels/telegram'
import { telegramUserPlugin } from './channels/telegram-user'
import { linePlugin } from './channels/line'
import { ChannelRegistry } from './channels/registry'
import { channelKey } from '@shared/domain'
import { ChannelManager } from './core/channel-manager'
import { JsonMessageStore } from './core/json-message-store'
import { SettingsStore } from './core/settings-store'
import { registerIpc } from './ipc'
import { initLogging } from './logging'
import { installAppMenu } from './menu'
import { TranslationPipeline } from './translation/pipeline'
import { PassthroughTranslator } from './translation/passthrough-translator'
import { configurePipeline, createTranslatorRegistry } from './translation/plugins'
import { createMainWindow } from './window'

// 本地媒体协议：omni-media://local/<mediaId>（必须在 ready 前注册特权）
protocol.registerSchemesAsPrivileged([
  { scheme: 'omni-media', privileges: { stream: true, supportFetchAPI: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // 未打包时 Electron 默认把 userData 指到共享的 "Electron" 目录，显式固定到应用专属目录
  app.setPath('userData', join(app.getPath('appData'), 'OmniChat'))
  await app.whenReady()

  const userData = app.getPath('userData')
  const logger = initLogging(join(userData, 'logs'))
  logger.info('OmniChat 启动', { version: app.getVersion(), userData })

  const settings = new SettingsStore(userData)
  await settings.init()

  const store = new JsonMessageStore(join(userData, 'data'))
  await store.init()

  const media = new MediaStore(join(userData, 'media'))
  await media.init()

  const contacts = new JsonContactStore(join(userData, 'data'))
  await contacts.init()

  protocol.handle('omni-media', (request) => {
    const mediaId = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    const abs = media.resolvePath(mediaId)
    if (!abs) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })

  const translatorRegistry = createTranslatorRegistry()
  const pipeline = new TranslationPipeline(new PassthroughTranslator())
  const pipelineExtras = {
    getBackend: () => ({
      serverUrl: settings.get().sync.serverUrl,
      token: settings.get().sync.token
    })
  }
  configurePipeline(pipeline, translatorRegistry, settings.get().translation, pipelineExtras)

  const broadcast = (evt: OmniEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(OMNI_EVENT_CHANNEL, evt)
    }
  }

  const notifier = new Notifier({
    getConfig: () => settings.get().notifications,
    logger,
    onActivate: (conversationId) => broadcast({ type: 'conversation:open', conversationId })
  })

  /** 收到入站消息时弹系统通知（窗口已聚焦则跳过，通知里带账号备注名） */
  const notifyOnInbound = (evt: OmniEvent): void => {
    if (evt.type !== 'message:new' || evt.message.direction !== 'in') return
    const key = `${evt.message.channel}:${evt.message.accountId}`
    notifier.notifyInbound(evt.message, evt.conversation, settings.accountConfig(key).label)
  }

  const manager = new ChannelManager(
    store,
    pipeline,
    (evt) => {
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

  // ── 渠道插件装配。新增平台：注册插件即可（下面按 kind 通用创建适配器）──
  const channels = new ChannelRegistry()
  channels.register(whatsAppPlugin)
  channels.register(telegramUserPlugin)
  channels.register(telegramBotPlugin)
  channels.register(linePlugin)

  const registerAccount = (kind: string, accountId: string): void => {
    const plugin = channels.get(kind as never)
    const key = `${kind}:${accountId}`
    manager.register(
      plugin.createAdapter(accountId, {
        dataDir: join(userData, 'channels', kind),
        logger,
        getAccountConfig: () => {
          const cfg = settings.accountConfig(key)
          return { proxyUrl: cfg.proxyUrl, deviceLabel: cfg.deviceLabel, credentials: cfg.credentials }
        },
        saveMedia: (data, ext) => media.save(data, ext),
        getBackend: () => {
          const s = settings.get().sync
          return { url: s.serverUrl, token: s.token }
        },
        saveCredentials: async (credentials) => {
          const cfg = settings.accountConfig(key)
          await settings.update({ accounts: { [key]: { ...cfg, credentials } } })
        },
        getDefaults: () => {
          const p = settings.get().platform
          return { telegramApiId: p.telegramApiId, telegramApiHash: p.telegramApiHash }
        }
      })
    )
  }

  // 账号注册表 = settings.accounts 的 key 集合（whatsapp:main 始终存在）
  for (const key of Object.keys(settings.get().accounts)) {
    const sep = key.indexOf(':')
    const kind = key.slice(0, sep)
    const accountId = key.slice(sep + 1)
    if (accountId && channels.has(kind as never)) registerAccount(kind, accountId)
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
    getConfig: () => settings.get().sync,
    initialRecord: syncRecord,
    persistRecord: async (r) => {
      await mkdir(join(userData, 'data'), { recursive: true })
      await writeFile(syncRecordPath, JSON.stringify(r), 'utf8')
    },
    logger
  })
  syncClient.start()

  const auth = new ClientAuth(settings, logger)
  // 工单数据落后台（看板要能被团队公开访问），复用同步配置里的地址与登录令牌
  const campaignApi = new CampaignApi(() => settings.get().sync, logger)
  const billingApi = new BillingApi(() => settings.get().sync, logger)

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
    broadcast,
    onSettingsChanged: (updated) => {
      configurePipeline(pipeline, translatorRegistry, updated.translation, pipelineExtras)
      logger.info('设置已更新')
    },
    onAddAccount: async (channel) => {
      if (!channels.has(channel as never)) throw new Error(`暂不支持添加 ${channel} 账号`)
      const accountId = `${channel.slice(0, 2)}${Date.now().toString(36)}`
      const key = channelKey(channel as never, accountId)
      await settings.update({ accounts: { [key]: {} } })
      registerAccount(channel, accountId)
      // 扫码类立即启动（显示二维码）；填凭证类等用户填完凭证再连
      const plugin = channels.get(channel as never)
      if (plugin.authType === 'qr') await manager.start(key)
      logger.info('新增账号', { key })
      return key
    },
    onRemoveAccount: async (key) => {
      if (key === 'whatsapp:main') throw new Error('主账号不可删除，只能退出登录')
      await manager.logout(key).catch(() => undefined)
      await manager.unregister(key)
      await settings.removeAccount(key)
      logger.info('已删除账号', { key })
    }
  })

  installAppMenu()
  createMainWindow()
  void manager.startAll()

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  app.on('window-all-closed', () => {
    // 保持后台在线收消息是这类客服工具的预期行为；macOS 关窗不退出
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    syncClient.stop()
    void manager.stopAll()
    void store.flush()
  })
}
