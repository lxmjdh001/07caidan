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
  listChannelPlugins: () => ipcRenderer.invoke(IPC_METHODS.listChannelPlugins),
  startChannel: (key: string) => ipcRenderer.invoke(IPC_METHODS.startChannel, key),
  submitAuthInput: (key: string, value: string) =>
    ipcRenderer.invoke(IPC_METHODS.submitAuthInput, key, value),
  setLoginMode: (key: string, mode: 'qr' | 'phone') =>
    ipcRenderer.invoke(IPC_METHODS.setLoginMode, key, mode),
  campaign: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(IPC_METHODS.campaignCall, method, args),
  billing: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(IPC_METHODS.billingCall, method, args),
  setUnreadTotal: (total: number) => ipcRenderer.invoke(IPC_METHODS.setUnreadTotal, total),
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
  authState: () => ipcRenderer.invoke(IPC_METHODS.authState),
  authConfig: (serverUrl: string) => ipcRenderer.invoke(IPC_METHODS.authConfig, serverUrl),
  authSendCode: (serverUrl: string, email: string) =>
    ipcRenderer.invoke(IPC_METHODS.authSendCode, serverUrl, email),
  authRegister: (serverUrl: string, email: string, password: string, code?: string) =>
    ipcRenderer.invoke(IPC_METHODS.authRegister, serverUrl, email, password, code),
  authLogin: (serverUrl: string, email: string, password: string) =>
    ipcRenderer.invoke(IPC_METHODS.authLogin, serverUrl, email, password),
  authLogout: () => ipcRenderer.invoke(IPC_METHODS.authLogout),
  onEvent: (cb: (evt: OmniEvent) => void) => {
    const listener = (_e: IpcRendererEvent, evt: OmniEvent): void => cb(evt)
    ipcRenderer.on(OMNI_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(OMNI_EVENT_CHANNEL, listener)
  }
}

contextBridge.exposeInMainWorld('omni', api)
