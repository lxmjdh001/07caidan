import { ipcMain } from 'electron'
import { IPC_METHODS } from '@shared/ipc'
import type { AppSettings } from '@shared/settings'
import type { ChannelManager } from './core/channel-manager'
import type { MessageStore } from './core/message-store'
import type { SettingsStore } from './core/settings-store'
import type { TranslatorRegistry } from './translation/registry'

export interface IpcDeps {
  manager: ChannelManager
  store: MessageStore
  settings: SettingsStore
  translators: TranslatorRegistry
  /** 设置更新后的回调（重新装配翻译管道等） */
  onSettingsChanged: (settings: AppSettings) => void
}

/** 渲染进程可调用的全部主进程能力，集中在此注册 */
export function registerIpc(deps: IpcDeps): void {
  const { manager, store, settings, translators } = deps

  ipcMain.handle(IPC_METHODS.listChannels, () => manager.listChannels())
  ipcMain.handle(IPC_METHODS.startChannel, (_e, key: string) => manager.start(key))
  ipcMain.handle(IPC_METHODS.logoutChannel, (_e, key: string) => manager.logout(key))

  ipcMain.handle(IPC_METHODS.listConversations, () => store.listConversations())
  ipcMain.handle(IPC_METHODS.listMessages, (_e, conversationId: string, limit?: number) =>
    store.listMessages(conversationId, limit)
  )
  ipcMain.handle(IPC_METHODS.sendText, (_e, conversationId: string, text: string) =>
    manager.sendText(conversationId, text)
  )
  ipcMain.handle(IPC_METHODS.markRead, (_e, conversationId: string) =>
    store.markRead(conversationId)
  )

  ipcMain.handle(IPC_METHODS.getSettings, () => settings.get())
  ipcMain.handle(IPC_METHODS.updateSettings, async (_e, patch: Partial<AppSettings>) => {
    const updated = await settings.update(patch)
    deps.onSettingsChanged(updated)
    return updated
  })
  ipcMain.handle(IPC_METHODS.listTranslators, () => translators.list())
}
