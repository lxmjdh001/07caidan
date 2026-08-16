import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_METHODS, type OmniEvent, type OutboundPreview } from '@shared/ipc'
import type { AppSettings } from '@shared/settings'
import type { ClientAuth } from './auth/client-auth'
import type { ChannelRegistry } from './channels/registry'
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
  /** 设置更新后的回调（重新装配翻译管道等） */
  onSettingsChanged: (settings: AppSettings) => void
  /** 主动推送事件到渲染进程 */
  broadcast: (evt: OmniEvent) => void
  /** 新增账号（返回 channel key） */
  onAddAccount: (channel: string) => Promise<string>
  /** 删除账号 */
  onRemoveAccount: (key: string) => Promise<void>
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
  ipcMain.handle(IPC_METHODS.authLogin, (_e, url: string, email: string, pw: string) =>
    auth.login(url, email, pw)
  )
  ipcMain.handle(IPC_METHODS.authLogout, () => auth.logout())
}
