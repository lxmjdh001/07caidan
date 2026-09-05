import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_METHODS, type OmniEvent, type OutboundPreview } from '@shared/ipc'
import type { AccountConfig, AppSettings, ProxyAsset, ProxyVerification } from '@shared/settings'
import type { ClientAuth } from './auth/client-auth'
import type { ChannelRegistry } from './channels/registry'
import type { BillingApi } from './billing/billing-api'
import { openCrispWindow } from './core/crisp'
import { deviceId, osInfo } from './core/device-id'
import type { CampaignApi } from './campaigns/campaign-api'
import type { ConfigSync } from './sync/config-sync-service'
import type { SyncClient } from './sync/sync-client'
import type { MediaStore } from './core/media-store'
import type { Notifier } from './core/notifier'
import type { AppUpdater } from './core/updater'
import { transcribeMessage } from './core/transcriber'
import type { ChannelManager } from './core/channel-manager'
import type { MessageStore } from './core/message-store'
import type { SettingsStore } from './core/settings-store'
import type { TranslatorRegistry } from './translation/registry'
import type { AccountNetworkIsolation } from './core/network-isolation'
import type { ConfigureAccountNetworkInput, ProxyProbe, SaveProxyAssetInput } from '@shared/network'
import { normalizeProxyForAccount, normalizeProxyUrl } from './core/proxy'

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
  configSync: ConfigSync
  syncClient: SyncClient
  networkIsolation: AccountNetworkIsolation
  version: string
  /** 设置更新后的回调（重新装配翻译管道等） */
  onSettingsChanged: (settings: AppSettings) => void
  /** 主动推送事件到渲染进程 */
  broadcast: (evt: OmniEvent) => void
  /** 新增账号（返回 channel key） */
  onAddAccount: (channel: string) => Promise<string>
  /** 删除账号 */
  onRemoveAccount: (key: string) => Promise<void>
  /** 登录成功后恢复服务器托管的渠道账号。 */
  onAuthReady: () => Promise<void>
  /** 用户确认退出应用 */
  onQuit: () => void
}

/** 允许渲染进程调用的工单接口白名单 */
const CAMPAIGN_METHODS: Record<string, true> = {
  available: true,
  listCampaigns: true,
  createCampaign: true,
  updateCampaign: true,
  uploadAvatar: true,
  deleteCampaign: true,
  campaignStats: true,
  listLinks: true,
  createLink: true,
  listEntryLinks: true,
  createEntryLink: true,
  deleteEntryLink: true,
  revokeLink: true,
  restoreLink: true,
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
  listProxyVendors: true,
  createOrder: true,
  subscribe: true,
  setAutoRenew: true,
  exchangeCredits: true,
  listNotices: true,
  markNoticesRead: true,
  listTickets: true,
  createTicket: true,
  getTicket: true,
  replyTicket: true,
  closeTicket: true,
  uploadTicketImage: true,
  fetchMedia: true,
  myIdentity: true,
  listTeamMembers: true,
  createTeamMember: true,
  updateTeamMember: true,
  deleteTeamMember: true,
  listTeamRoles: true,
  createTeamRole: true,
  deleteTeamRole: true,
  listDevices: true,
  revokeDevice: true
}

/** 渲染进程可调用的全部主进程能力，集中在此注册 */
export function registerIpc(deps: IpcDeps): void {
  const { manager, store, settings, translators } = deps

  ipcMain.handle(IPC_METHODS.listChannels, () => manager.listChannels())
  ipcMain.handle(IPC_METHODS.refreshChannelProfile, (_e, key: string) =>
    manager.refreshSelfProfile(key)
  )
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
  ipcMain.handle(IPC_METHODS.beginOAuth, (_e, key: string) => manager.beginOAuth(key))
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
  ipcMain.handle(IPC_METHODS.quitApp, () => deps.onQuit())

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
  ipcMain.handle(
    IPC_METHODS.setAccountEnabled,
    async (_e, key: string, enabled: boolean) => {
      if (typeof enabled !== 'boolean') throw new Error('账号启用状态无效')
      if (!settings.get().accounts[key]) throw new Error(`账号不存在：${key}`)
      const config = settings.accountConfig(key)
      await settings.update({ accounts: { [key]: { ...config, disabled: !enabled } } })
      await manager.setAccountEnabled(key, enabled)
    }
  )
  ipcMain.handle(IPC_METHODS.listAccountNetworks, () =>
    deps.networkIsolation.list(Object.keys(settings.get().accounts))
  )
  ipcMain.handle(IPC_METHODS.testProxy, (_e, proxyUrl: string) => {
    validateProxyUrlInput(proxyUrl)
    return deps.networkIsolation.testProxy(proxyUrl)
  })
  ipcMain.handle(
    IPC_METHODS.saveProxyAsset,
    async (_e, input: SaveProxyAssetInput) => {
      if (!input || typeof input !== 'object') throw new Error('代理配置无效')
      validateProxyUrlInput(input.proxyUrl)
      const snapshot = settings.get()
      const requestedId = input.id
      if (requestedId !== undefined && !validProxyAssetId(requestedId)) throw new Error('代理记录 ID 无效')
      const existing = requestedId ? snapshot.proxyAssets[requestedId] : undefined
      if (requestedId && !existing) throw new Error('代理记录不存在或已删除')
      if (!existing && Object.keys(snapshot.proxyAssets).length >= 2_000) {
        throw new Error('代理记录数量已达上限')
      }

      const id = existing?.id ?? randomUUID()
      const linkedKeys = Object.entries(snapshot.accounts)
        .filter(([, account]) => account.proxyId === id)
        .map(([key]) => key)
      // 已经关联 Telegram 的资产不能被编辑成 HTTP，避免保存后账号静默失去隔离连接。
      for (const key of linkedKeys) normalizeProxyForAccount(key, input.proxyUrl)
      if (input.verify !== undefined && typeof input.verify !== 'boolean') {
        throw new Error('代理检测参数无效')
      }

      // 普通保存立即写入；只有用户明确点击“检测”才运行多目标连通性探测。
      const probe = input.verify
        ? await deps.networkIsolation.testProxy(input.proxyUrl)
        : undefined
      const savedProxyUrl = probe?.proxyUrl ?? normalizeProxyUrl(input.proxyUrl)
      const note = cleanProxyNote(input.note, existing?.note)
      const changed = Boolean(existing && existing.proxyUrl !== savedProxyUrl)
      if (changed) {
        for (const key of linkedKeys) await stopAccountIfRunning(manager, key)
      }

      const now = Date.now()
      const createdAt = existing?.createdAt ?? probe?.checkedAt ?? now
      const verification = probe
        ? verificationFromProbe(probe)
        : (!changed ? existing?.verification : undefined)
      const asset: ProxyAsset = {
        id,
        proxyUrl: savedProxyUrl,
        note,
        createdAt,
        updatedAt: probe?.checkedAt ?? now,
        verification
      }
      const proxyAssets = { ...snapshot.proxyAssets, [id]: asset }
      const accounts = structuredClone(snapshot.accounts)
      for (const key of linkedKeys) {
        accounts[key] = applyProxyAsset(accounts[key] ?? {}, asset)
      }
      const updated = await settings.replaceNetworkConfig(accounts, proxyAssets)
      deps.onSettingsChanged(updated)
      for (const key of linkedKeys) {
        if (probe) deps.networkIsolation.markReady(key, probe)
        else deps.networkIsolation.reset(key)
      }
      return { asset, ...(probe ? { probe } : {}), settings: updated }
    }
  )
  ipcMain.handle(IPC_METHODS.deleteProxyAsset, async (_e, id: string) => {
    if (!validProxyAssetId(id)) throw new Error('代理记录 ID 无效')
    const snapshot = settings.get()
    if (!snapshot.proxyAssets[id]) throw new Error('代理记录不存在或已删除')
    const linkedKeys = Object.entries(snapshot.accounts)
      .filter(([, account]) => account.proxyId === id)
      .map(([key]) => key)
    for (const key of linkedKeys) await stopAccountIfRunning(manager, key)

    const accounts = structuredClone(snapshot.accounts)
    for (const key of linkedKeys) accounts[key] = withoutProxy(accounts[key] ?? {})
    const proxyAssets = structuredClone(snapshot.proxyAssets)
    delete proxyAssets[id]
    const updated = await settings.replaceNetworkConfig(accounts, proxyAssets)
    deps.onSettingsChanged(updated)
    for (const key of linkedKeys) deps.networkIsolation.reset(key)
    return updated
  })
  ipcMain.handle(IPC_METHODS.unlinkAccountProxy, async (_e, key: string) => {
    const snapshot = settings.get()
    if (!snapshot.accounts[key]) throw new Error(`账号不存在：${key}`)
    await stopAccountIfRunning(manager, key)
    const accounts = structuredClone(snapshot.accounts)
    accounts[key] = withoutProxy(accounts[key] ?? {})
    const updated = await settings.replaceNetworkConfig(accounts, snapshot.proxyAssets)
    deps.onSettingsChanged(updated)
    deps.networkIsolation.reset(key)
    return updated
  })
  ipcMain.handle(
    IPC_METHODS.setProxyAssetBindings,
    async (_e, assetId: string, requestedKeys: string[]) => {
      if (!validProxyAssetId(assetId)) throw new Error('代理记录 ID 无效')
      if (!Array.isArray(requestedKeys) || requestedKeys.length > 5_000) {
        throw new Error('关联账号列表无效或数量过多')
      }

      const snapshot = settings.get()
      const asset = snapshot.proxyAssets[assetId]
      if (!asset) throw new Error('代理记录不存在或已删除')

      const selectedKeys = [...new Set(requestedKeys)]
      for (const key of selectedKeys) {
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]{1,128}$/.test(key)) {
          throw new Error('关联账号标识无效')
        }
        const account = snapshot.accounts[key]
        if (!account) throw new Error(`账号不存在：${key}`)
        if (!account.fingerprint) throw new Error(`账号设备指纹尚未生成：${key}`)
        // 在写入前一次性验证全部平台兼容性，避免只保存一半。
        normalizeProxyForAccount(key, asset.proxyUrl)
      }

      const selected = new Set(selectedKeys)
      const currentlyLinked = Object.entries(snapshot.accounts)
        .filter(([, account]) => account.proxyId === assetId)
        .map(([key]) => key)
      const affected = [...new Set([
        ...currentlyLinked.filter((key) => !selected.has(key)),
        ...selectedKeys.filter((key) => snapshot.accounts[key]?.proxyId !== assetId)
      ])]

      await Promise.all(affected.map((key) => stopAccountIfRunning(manager, key)))

      const accounts = structuredClone(snapshot.accounts)
      for (const key of currentlyLinked) {
        if (!selected.has(key)) accounts[key] = withoutProxy(accounts[key] ?? {})
      }
      for (const key of selectedKeys) accounts[key] = applyProxyAsset(accounts[key] ?? {}, asset)

      const updated = await settings.replaceNetworkConfig(accounts, snapshot.proxyAssets)
      deps.onSettingsChanged(updated)
      for (const key of affected) deps.networkIsolation.reset(key)
      return updated
    }
  )
  ipcMain.handle(
    IPC_METHODS.testAccountProxy,
    (_e, key: string, proxyUrl: string) => {
      if (typeof key !== 'string' || !key || !settings.get().accounts[key]) {
        throw new Error('请选择需要检测代理的平台账号')
      }
      if (typeof proxyUrl !== 'string' || !proxyUrl.trim() || proxyUrl.length > 2_048) {
        throw new Error('代理地址为空或长度无效')
      }
      return deps.networkIsolation.testConnection(key, proxyUrl)
    }
  )
  ipcMain.handle(
    IPC_METHODS.configureAccountNetwork,
    async (_e, key: string, input: ConfigureAccountNetworkInput) => {
      if (!input || typeof input !== 'object') throw new Error('账号代理配置无效')
      const snapshot = settings.get()
      const current = snapshot.accounts[key]
      if (!current) throw new Error(`账号不存在：${key}`)
      if (!current.fingerprint) throw new Error('设备指纹尚未生成，无法配置网络')
      if (input.proxyId !== undefined && !validProxyAssetId(input.proxyId)) {
        throw new Error('代理记录 ID 无效')
      }
      if (input.connect !== undefined && typeof input.connect !== 'boolean') {
        throw new Error('连接参数无效')
      }
      if (input.skipTest !== undefined && typeof input.skipTest !== 'boolean') {
        throw new Error('代理检测参数无效')
      }
      const selectedAsset = input.proxyId ? snapshot.proxyAssets[input.proxyId] : undefined
      if (input.proxyId && !selectedAsset) throw new Error('所选代理不存在或已删除')
      const candidateProxyUrl = selectedAsset?.proxyUrl ?? input.proxyUrl ?? ''
      validateProxyUrlInput(candidateProxyUrl)
      const normalizedProxyUrl = normalizeProxyForAccount(key, candidateProxyUrl)
      // 手动检测入口仍先探测；账号弹窗可明确跳过，直接交给平台连接判断。
      const probe = input.skipTest
        ? undefined
        : await deps.networkIsolation.test(key, normalizedProxyUrl)
      let oldProxy: string | undefined
      try {
        oldProxy = current.proxyUrl ? normalizeProxyForAccount(key, current.proxyUrl) : undefined
      } catch {
        // 旧版本可能保存过不完整地址；新候选已通过严格检测，直接视为发生变更。
        oldProxy = undefined
      }
      const savedProxyUrl = probe?.proxyUrl ?? normalizedProxyUrl
      const changed = oldProxy !== savedProxyUrl
      const proxyNote = selectedAsset?.note ?? cleanProxyNote(input.note, current.proxyNote)
      if (changed) await stopAccountIfRunning(manager, key)
      const id = selectedAsset?.id ?? randomUUID()
      const now = Date.now()
      const createdAt = selectedAsset?.createdAt ?? (!changed ? current.proxyCreatedAt : undefined) ?? now
      const verification = probe
        ? verificationFromProbe(probe)
        : selectedAsset?.verification ?? (!changed ? current.proxyVerification : undefined)
      const asset: ProxyAsset = selectedAsset
        ? { ...selectedAsset, proxyUrl: savedProxyUrl, updatedAt: probe?.checkedAt ?? now, verification }
        : { id, proxyUrl: savedProxyUrl, note: proxyNote, createdAt, updatedAt: probe?.checkedAt ?? now, verification }
      const accounts = structuredClone(snapshot.accounts)
      accounts[key] = applyProxyAsset(current, asset)
      const updated = await settings.replaceNetworkConfig(
        accounts,
        { ...snapshot.proxyAssets, [id]: asset }
      )
      deps.onSettingsChanged(updated)
      if (probe) deps.networkIsolation.markReady(key, probe)
      else deps.networkIsolation.reset(key)

      let connectionError: string | undefined
      if (input.connect && !updated.accounts[key]?.disabled) {
        try {
          await manager.start(key)
        } catch {
          connectionError = '网络错误'
        }
      }
      return {
        ...(probe ? { probe } : {}),
        settings: updated,
        ...(connectionError ? { connectionError } : {})
      }
    }
  )
  ipcMain.handle(IPC_METHODS.listGroups, (_e, key: string) => manager.listGroups(key))
  ipcMain.handle(
    IPC_METHODS.createGroup,
    (_e, key: string, subject: string, participantIds: string[]) =>
      manager.createGroup(key, subject, participantIds)
  )

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
  ipcMain.handle(IPC_METHODS.markRead, async (_e, conversationId: string) => {
    await store.markRead(conversationId)
    await deps.syncClient.markRead(conversationId)
  })

  ipcMain.handle(
    IPC_METHODS.setConversationLang,
    async (_e, conversationId: string, lang: string | null) => {
      const updated = await store.patchConversation({ id: conversationId, langOverride: lang })
      if (updated) {
        await deps.syncClient.markConversationDirty(conversationId)
        deps.broadcast({ type: 'conversation:updated', conversation: updated })
      }
    }
  )

  ipcMain.handle(
    IPC_METHODS.setConversationAutoReply,
    async (_e, conversationId: string, on: boolean) => {
      const updated = await store.patchConversation({ id: conversationId, autoReply: on })
      if (updated) {
        await deps.syncClient.markConversationDirty(conversationId)
        deps.broadcast({ type: 'conversation:updated', conversation: updated })
      }
    }
  )

  ipcMain.handle(
    IPC_METHODS.setConversationPinned,
    async (_e, conversationId: string, pinned: boolean) => {
      const updated = await store.patchConversation({ id: conversationId, pinned })
      if (updated) {
        await deps.syncClient.markConversationDirty(conversationId)
        deps.broadcast({ type: 'conversation:updated', conversation: updated })
      }
    }
  )

  ipcMain.handle(IPC_METHODS.setConversationMuted, async (_e, conversationId: string, muted: boolean) => {
    const updated = await store.patchConversation({ id: conversationId, muted: Boolean(muted) })
    if (updated) {
      await deps.syncClient.markConversationDirty(conversationId)
      deps.broadcast({ type: 'conversation:updated', conversation: updated })
    }
  })
  ipcMain.handle(IPC_METHODS.clearConversation, async (_e, conversationId: string) => {
    await store.clearConversation(conversationId)
    const updated = await store.getConversation(conversationId)
    if (updated) deps.broadcast({ type: 'conversation:updated', conversation: updated })
  })
  ipcMain.handle(IPC_METHODS.deleteConversation, async (_e, conversationId: string) => {
    await store.deleteConversation(conversationId)
    deps.broadcast({ type: 'conversation:removed', conversationId })
  })
  ipcMain.handle(IPC_METHODS.inheritAccountConversations, (_e, sourceAccountKey: string, targetAccountKey: string) =>
    store.inheritAccountConversations(sourceAccountKey, targetAccountKey)
  )
  ipcMain.handle(IPC_METHODS.updateConversationProfile, async (_e, conversationId: string, title: string, customerNote: string) => {
    const updated = await store.patchConversation({ id: conversationId, title: title.trim() || undefined, customerNote })
    if (updated) {
      await deps.syncClient.markConversationDirty(conversationId)
      deps.broadcast({ type: 'conversation:updated', conversation: updated })
    }
  })

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
    // 渲染进程改了偏好 → 防抖上云（服务会自行判断是否开启云同步）
    deps.configSync.pushDebounced()
    return updated
  })
  ipcMain.handle(IPC_METHODS.listTranslators, () => translators.list())

  const { auth } = deps
  ipcMain.handle(IPC_METHODS.authState, () => auth.state())
  ipcMain.handle(IPC_METHODS.authRefresh, () => auth.refreshPermissions())

  // ── Crisp 在线客服（M20）──
  /** Website ID 由后台下发；缓存 10 分钟，避免每次打开支持页都打一次网络 */
  let crispCache: { id: string | undefined; at: number } | null = null
  const crispWebsiteId = async (): Promise<string | undefined> => {
    const sync = deps.settings.get().sync
    if (!sync.serverUrl) return undefined
    if (crispCache && Date.now() - crispCache.at < 10 * 60_000) return crispCache.id
    try {
      const res = await fetch(`${sync.serverUrl.replace(/\/$/, '')}/api/client/config`, {
        signal: AbortSignal.timeout(10_000)
      })
      const data = (await res.json().catch(() => ({}))) as { crispWebsiteId?: string }
      crispCache = { id: data.crispWebsiteId || undefined, at: Date.now() }
      return crispCache.id
    } catch {
      return crispCache?.id
    }
  }

  ipcMain.handle(IPC_METHODS.crispAvailable, async () => (await crispWebsiteId()) !== undefined)

  ipcMain.handle(IPC_METHODS.crispOpen, async () => {
    const id = await crispWebsiteId()
    if (!id) return { ok: false, error: '在线客服未配置' }
    const sync = deps.settings.get().sync
    // 会话数据尽力而为：拿不到账单信息也照样开窗
    const data: Array<[string, string]> = [
      ['app_version', app.getVersion()],
      ['os', `${osInfo().osType} ${osInfo().osVersion}`],
      ['device_id', deviceId()],
      ['role', sync.role ?? '']
    ]
    try {
      const me = (await deps.billingApi.me()) as {
        balance?: number
        plan?: { name?: string } | null
        subscription?: { expiresAt?: number; status?: string } | null
      }
      if (me.plan?.name) data.push(['plan', me.plan.name])
      if (me.subscription?.expiresAt) {
        data.push(['plan_expires', new Date(me.subscription.expiresAt).toISOString().slice(0, 10)])
      }
      if (typeof me.balance === 'number') {
        data.push(['balance_usd', (me.balance / 100).toFixed(2)])
      }
    } catch {
      // 客服子账号无 billing:manage 或未登录：跳过套餐信息
    }
    try {
      await openCrispWindow(id, { email: sync.email || undefined, data })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle(IPC_METHODS.authConfig, (_e, url: string) => auth.config(url))
  ipcMain.handle(IPC_METHODS.authSendCode, (_e, url: string, email: string) =>
    auth.sendCode(url, email)
  )
  ipcMain.handle(
    IPC_METHODS.authRegister,
    async (_e, url: string, email: string, pw: string, code?: string) => {
      const r = await auth.register(url, email, pw, code)
      if (r.ok) {
        await deps.configSync.pull()
        await deps.onAuthReady()
        void deps.syncClient.runOnce()
      }
      return r
    }
  )
  ipcMain.handle(IPC_METHODS.authForgotPassword, (_e, serverUrl: string, email: string) =>
    deps.auth.forgotPassword(serverUrl, email)
  )
  ipcMain.handle(
    IPC_METHODS.authResetPassword,
    (_e, serverUrl: string, email: string, code: string, password: string) =>
      deps.auth.resetPassword(serverUrl, email, code, password)
  )
  ipcMain.handle(IPC_METHODS.authLogin, async (_e, url: string, email: string, pw: string) => {
    const r = await auth.login(url, email, pw)
    if (r.ok) {
      await deps.configSync.pull()
      await deps.onAuthReady()
      void deps.syncClient.runOnce()
    }
    return r
  })
  ipcMain.handle(IPC_METHODS.authLogout, () => auth.logout())
}

function validateProxyUrlInput(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) {
    throw new Error('代理地址为空或长度无效')
  }
}

function validProxyAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
}

function cleanProxyNote(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error('代理备注格式无效')
  return value.trim().slice(0, 160) || undefined
}

function verificationFromProbe(probe: ProxyProbe): ProxyVerification {
  return {
    proxyHash: probe.proxyHash,
    ...(probe.exitIp ? { exitIp: probe.exitIp } : {}),
    checkedAt: probe.checkedAt,
    latencyMs: probe.latencyMs
  }
}

function applyProxyAsset(account: AccountConfig, asset: ProxyAsset): AccountConfig {
  return {
    ...account,
    proxyId: asset.id,
    proxyUrl: asset.proxyUrl,
    proxyNote: asset.note,
    proxyCreatedAt: asset.createdAt,
    proxyVerification: asset.verification ? structuredClone(asset.verification) : undefined
  }
}

function withoutProxy(account: AccountConfig): AccountConfig {
  const next = { ...account }
  delete next.proxyId
  delete next.proxyUrl
  delete next.proxyNote
  delete next.proxyCreatedAt
  delete next.proxyVerification
  return next
}

async function stopAccountIfRunning(manager: ChannelManager, key: string): Promise<void> {
  const state = manager.listChannels().find((item) => `${item.kind}:${item.accountId}` === key)
  if (state && state.status !== 'stopped' && state.status !== 'logged_out') {
    await manager.stop(key)
  }
}
