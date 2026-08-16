import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_METHODS,
  OMNI_EVENT_CHANNEL,
  type OmniApi,
  type OmniEvent,
  type OutboundPreview
} from '@shared/ipc'
import type { AppSettings } from '@shared/settings'

/** 渲染进程唯一的主进程入口：window.omni（contextIsolation 隔离下的白名单桥） */
const api: OmniApi = {
  platform: process.platform,
  listChannels: () => ipcRenderer.invoke(IPC_METHODS.listChannels),
  startChannel: (key: string) => ipcRenderer.invoke(IPC_METHODS.startChannel, key),
  logoutChannel: (key: string) => ipcRenderer.invoke(IPC_METHODS.logoutChannel, key),
  addAccount: (channel: string) => ipcRenderer.invoke(IPC_METHODS.addAccount, channel),
  removeAccount: (key: string) => ipcRenderer.invoke(IPC_METHODS.removeAccount, key),
  listConversations: () => ipcRenderer.invoke(IPC_METHODS.listConversations),
  listMessages: (conversationId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_METHODS.listMessages, conversationId, limit),
  sendText: (conversationId: string, text: string, prepared?: OutboundPreview) =>
    ipcRenderer.invoke(IPC_METHODS.sendText, conversationId, text, prepared),
  previewOutbound: (conversationId: string, text: string) =>
    ipcRenderer.invoke(IPC_METHODS.previewOutbound, conversationId, text),
  sendMedia: (conversationId: string) => ipcRenderer.invoke(IPC_METHODS.sendMedia, conversationId),
  setConversationLang: (conversationId: string, lang: string | null) =>
    ipcRenderer.invoke(IPC_METHODS.setConversationLang, conversationId, lang),
  markRead: (conversationId: string) => ipcRenderer.invoke(IPC_METHODS.markRead, conversationId),
  getSettings: () => ipcRenderer.invoke(IPC_METHODS.getSettings),
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC_METHODS.updateSettings, patch),
  listTranslators: () => ipcRenderer.invoke(IPC_METHODS.listTranslators),
  onEvent: (cb: (evt: OmniEvent) => void) => {
    const listener = (_e: IpcRendererEvent, evt: OmniEvent): void => cb(evt)
    ipcRenderer.on(OMNI_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(OMNI_EVENT_CHANNEL, listener)
  }
}

contextBridge.exposeInMainWorld('omni', api)
