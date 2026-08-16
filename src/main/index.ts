import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol } from 'electron'
import { OMNI_EVENT_CHANNEL, type OmniEvent } from '@shared/ipc'
import { JsonContactStore } from './core/contact-store'
import { MediaStore } from './core/media-store'
import { whatsAppPlugin } from './channels/whatsapp'
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
  configurePipeline(pipeline, translatorRegistry, settings.get().translation)

  const broadcast = (evt: OmniEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(OMNI_EVENT_CHANNEL, evt)
    }
  }

  const manager = new ChannelManager(
    store,
    pipeline,
    broadcast,
    logger.child('manager'),
    media,
    contacts
  )
  // 出站翻译目标语言的账号级/全局默认（会话级优先逻辑在 ChannelManager 内）
  manager.getLangDefaults = (key) => ({
    accountDefault: settings.accountConfig(key).defaultLang,
    globalDefault: settings.get().translation.targetLangDefault
  })

  // ── 渠道插件装配。新增平台：注册插件 + 在此为账号创建适配器 ──
  const channels = new ChannelRegistry()
  channels.register(whatsAppPlugin)

  const registerWaAccount = (accountId: string): void => {
    const key = channelKey('whatsapp', accountId)
    manager.register(
      channels.get('whatsapp').createAdapter(accountId, {
        dataDir: join(userData, 'channels', 'whatsapp'),
        logger,
        getAccountConfig: () => settings.accountConfig(key),
        saveMedia: (data, ext) => media.save(data, ext)
      })
    )
  }

  // 账号注册表 = settings.accounts 的 key 集合（whatsapp:main 始终存在）
  for (const key of Object.keys(settings.get().accounts)) {
    const sep = key.indexOf(':')
    const kind = key.slice(0, sep)
    const accountId = key.slice(sep + 1)
    if (kind === 'whatsapp' && accountId) registerWaAccount(accountId)
  }

  registerIpc({
    manager,
    store,
    settings,
    translators: translatorRegistry,
    broadcast,
    onSettingsChanged: (updated) => {
      configurePipeline(pipeline, translatorRegistry, updated.translation)
      logger.info('设置已更新')
    },
    onAddAccount: async (channel) => {
      if (channel !== 'whatsapp') throw new Error(`暂不支持添加 ${channel} 账号`)
      const accountId = `wa${Date.now().toString(36)}`
      const key = channelKey('whatsapp', accountId)
      await settings.update({ accounts: { [key]: {} } })
      registerWaAccount(accountId)
      await manager.start(key)
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
    void manager.stopAll()
    void store.flush()
  })
}
