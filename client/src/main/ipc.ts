import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_METHODS, type OmniEvent, type OutboundPreview } from '@shared/ipc'
import type { AppSettings } from '@shared/settings'
import type { ClientAuth } from './auth/client-auth'
import type { ChannelRegistry } from './channels/registry'
import type { BillingApi } from './billing/billing-api'
import type { CampaignApi } from './campaigns/campaign-api'
import type { MediaStore } from './core/media-store'
import type { Notifier } from './core/notifier'
import type { AppUpdater } from './core/updater'
import { transcribeMessage } from './core/transcriber'
import type { ChannelManager } from './core/channel-manager'
import type { MessageStore } from './core/message-store'
import type { SettingsStore } from './core/settings-store'
import type { TranslatorRegistry } from './translation/registry'

export interface IpcDeps {
  manager: ChannelManager
  store: MessageStore
  settings: SettingsStore
  auth: ClientAuth
  channels: ChannelRegistry
  translators: TranslatorRegistry
  campaigns: CampaignApi
  billingApi: BillingApi
  media: MediaStore
  notifier: Notifier
  updater: AppUpdater
  version: string
  /** 设置更新后的回调（重新装配翻译管道等） */
  onSettingsChanged: (settings: AppSettings) => void
  /** 主动推送事件到渲染进程 */
  broadcast: (evt: OmniEvent) => void
  /** 新增账号（返回 channel key） */
  onAddAccount: (channel: string) => Promise<string>
  /** 删除账号 */
  onRemoveAccount: (key: string) => Promise<void>
}

/** 允许渲染进程调用的工单接口白名单 */
const CAMPAIGN_METHODS: Record<string, true> = {
  available: true,
  listCampaigns: true,
  createCampaign: true,
  updateCampaign: true,
  deleteCampaign: true,
  campaignStats: true,
  listLinks: true,
  createLink: true,
  revokeLink: true,
  deleteLink: true,
  listLibraries: true,
  importLibrary: true,
  exportLibrary: true,
  appendEntries: true,
  deleteLibrary: true
}

/** 允许渲染进程调用的计费接口白名单 */
const BILLING_METHODS: Record<string, true> = {
  me: true,
  listPlans: true,
  listChannels: true,
  listOrders: true,
  listLedger: true,
  createOrder: true,
  subscribe: true,
  setAutoRenew: true,
  exchangeCredits: true
}

/** 渲染进程可调用的全部主进程能力，集中在此注册 */
export function registerIpc(deps: IpcDeps): void {
  const { manager, store, settings, translators } = deps

  ipcMain.handle(IPC_METHODS.listChannels, () => manager.listChannels())
  ipcMain.handle(IPC_METHODS.listChannelPlugins, () =>
    deps.channels.list().map((p) => ({
      kind: p.kind,
      displayName: p.displayName,
      authType: p.authType,
      credentialFields: p.credentialFields
    }))
  )
  ipcMain.handle(IPC_METHODS.startChannel, (_e, key: string) => manager.start(key))
  ipcMain.handle(IPC_METHODS.setLoginMode, (_e, key: string, mode: string) =>
    manager.setLoginMode(key, mode)
  )
  ipcMain.handle(IPC_METHODS.submitAuthInput, (_e, key: string, value: string) =>
    manager.submitAuthInput(key, value)
  )
  ipcMain.handle(IPC_METHODS.logoutChannel, (_e, key: string) => manager.logout(key))
  ipcMain.handle(
    IPC_METHODS.sendVoice,
    (_e, conversationId: string, data: Uint8Array, mimeType: string, durationSec: number) =>
      manager.sendVoice(conversationId, data, mimeType, durationSec)
  )

  ipcMain.handle(IPC_METHODS.transcribeVoice, (_e, conversationId: string, messageId: string) =>
    transcribeMessage(
      {
        getMessages: (id) => store.listMessages(id, 2000),
        resolveMedia: (id) => deps.media.resolvePath(id) ?? undefined,
        asr: (body) => deps.billingApi.transcribe(body),
        saveMessage: async (msg) => {
          await store.updateMessage(msg)
          deps.broadcast({ type: 'message:updated', message: msg })
        }
      },
      conversationId,
      messageId
    )
  )

  ipcMain.handle(IPC_METHODS.appInfo, () => ({
    version: deps.version,
    updateState: deps.updater.state
  }))
  ipcMain.handle(IPC_METHODS.checkUpdates, () => deps.updater.checkNow())
  ipcMain.handle(IPC_METHODS.installUpdate, () => deps.updater.quitAndInstall())

  ipcMain.handle(IPC_METHODS.setUnreadTotal, (_e, total: number) => {
    deps.notifier.setUnreadTotal(Number(total) || 0)
  })

  // 工单 / 重粉库：方法名 + 参数数组转发到后台客户端。
  // 白名单校验，避免渲染进程随便点名调用对象上的任意属性。
  ipcMain.handle(IPC_METHODS.billingCall, async (_e, method: string, args: unknown[] = []) => {
    const api = deps.billingApi as unknown as Record<string, unknown>
    const fn = Object.prototype.hasOwnProperty.call(BILLING_METHODS, method)
      ? api[method]
      : undefined
    if (typeof fn !== 'function') throw new Error(`未知的计费接口：${method}`)
    return (fn as (...a: unknown[]) => Promise<unknown>).apply(api, args)
  })

  ipcMain.handle(IPC_METHODS.campaignCall, async (_e, method: string, args: unknown[] = []) => {
    const api = deps.campaigns as unknown as Record<string, unknown>
    const fn = Object.prototype.hasOwnProperty.call(CAMPAIGN_METHODS, method)
      ? api[method]
      : undefined
    if (typeof fn !== 'function') throw new Error(`未知的工单接口：${method}`)
    return (fn as (...a: unknown[]) => Promise<unknown>).apply(api, args)
  })
  ipcMain.handle(IPC_METHODS.addAccount, (_e, channel: string) => deps.onAddAccount(channel))
  ipcMain.handle(IPC_METHODS.removeAccount, (_e, key: string) => deps.onRemoveAccount(key))

  ipcMain.handle(IPC_METHODS.listConversations, () => store.listConversations())
  ipcMain.handle(IPC_METHODS.listMessages, (_e, conversationId: string, limit?: number) =>
    store.listMessages(conversationId, limit)
  )
  ipcMain.handle(
    IPC_METHODS.sendText,
    (_e, conversationId: string, text: string, prepared?: OutboundPreview) =>
      manager.sendText(conversationId, text, prepared)
  )
  ipcMain.handle(IPC_METHODS.previewOutbound, (_e, conversationId: string, text: string) =>
    manager.previewOutbound(conversationId, text)
  )
  ipcMain.handle(IPC_METHODS.markRead, (_e, conversationId: string) =>
    store.markRead(conversationId)
  )

  ipcMain.handle(
    IPC_METHODS.setConversationLang,
    async (_e, conversationId: string, lang: string | null) => {
      const updated = await store.patchConversation({ id: conversationId, langOverride: lang })
      if (updated) deps.broadcast({ type: 'conversation:updated', conversation: updated })
    }
  )

  ipcMain.handle(
    IPC_METHODS.setConversationAutoReply,
    async (_e, conversationId: string, on: boolean) => {
      const updated = await store.patchConversation({ id: conversationId, autoReply: on })
      if (updated) deps.broadcast({ type: 'conversation:updated', conversation: updated })
    }
  )

  ipcMain.handle(IPC_METHODS.sendMedia, async (e, conversationId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const picked = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        { name: '媒体与文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'ogg', 'wav', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'zip', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = picked.filePaths[0]
    if (picked.canceled || !filePath) return null
    return manager.sendMediaFile(conversationId, filePath)
  })

  ipcMain.handle(IPC_METHODS.getSettings, () => settings.get())
  ipcMain.handle(IPC_METHODS.updateSettings, async (_e, patch: Partial<AppSettings>) => {
    const updated = await settings.update(patch)
    deps.onSettingsChanged(updated)
    return updated
  })
  ipcMain.handle(IPC_METHODS.listTranslators, () => translators.list())

  const { auth } = deps
  ipcMain.handle(IPC_METHODS.authState, () => auth.state())
  ipcMain.handle(IPC_METHODS.authConfig, (_e, url: string) => auth.config(url))
  ipcMain.handle(IPC_METHODS.authSendCode, (_e, url: string, email: string) =>
    auth.sendCode(url, email)
  )
  ipcMain.handle(
    IPC_METHODS.authRegister,
    (_e, url: string, email: string, pw: string, code?: string) =>
      auth.register(url, email, pw, code)
  )
  ipcMain.handle(IPC_METHODS.authForgotPassword, (_e, serverUrl: string, email: string) =>
    deps.auth.forgotPassword(serverUrl, email)
  )
  ipcMain.handle(
    IPC_METHODS.authResetPassword,
    (_e, serverUrl: string, email: string, code: string, password: string) =>
      deps.auth.resetPassword(serverUrl, email, code, password)
  )
  ipcMain.handle(IPC_METHODS.authLogin, (_e, url: string, email: string, pw: string) =>
    auth.login(url, email, pw)
  )
  ipcMain.handle(IPC_METHODS.authLogout, () => auth.logout())
}
