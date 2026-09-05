import {
  app,
  BrowserWindow,
  session,
  type AuthenticationResponseDetails,
  type AuthInfo,
  type Event,
  type WebContents
} from 'electron'
import type { AccountFingerprint } from '@shared/settings'
import { normalizeProxyUrl } from './proxy'

interface IsolatedOAuthOptions {
  accountKey: string
  url: string
  proxyUrl: string
  fingerprint: AccountFingerprint
}

const windows = new Map<string, BrowserWindow>()

/**
 * OAuth 必须在账号独立的持久化 session 中完成，不能交给共享的系统浏览器。
 * fixed_servers 模式没有 DIRECT 备选；代理断开时 Chromium 显示连接失败，不会换本机出口。
 */
export async function openIsolatedOAuthWindow(options: IsolatedOAuthOptions): Promise<void> {
  const target = new URL(options.url)
  if (target.protocol !== 'https:') throw new Error('OAuth 登录地址必须使用 HTTPS')
  const proxy = parseElectronProxy(options.proxyUrl)
  const partition = `persist:omni-account-${options.fingerprint.id.toLowerCase()}`
  const isolatedSession = session.fromPartition(partition, { cache: true })
  await isolatedSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxy.rule,
    // Chromium 默认会绕过本机地址；显式反转，确保所有 OAuth 请求都进入代理。
    proxyBypassRules: '<-loopback>'
  })
  const resolved = await isolatedSession.resolveProxy(options.url)
  if (!resolved || resolved.split(';').some((entry) => entry.trim() === 'DIRECT')) {
    throw new Error('浏览器代理规则包含直连出口，安全隔离已阻止打开登录页')
  }

  windows.get(options.accountKey)?.destroy()
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: `${options.accountKey} · 安全登录`,
    show: false,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  windows.set(options.accountKey, win)
  isolatedSession.setUserAgent(stableDesktopUserAgent())

  const onLogin = (
    event: Event,
    webContents: WebContents,
    _details: AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void
  ): void => {
    if (webContents.id !== win.webContents.id || !authInfo.isProxy) return
    event.preventDefault()
    callback(proxy.username, proxy.password)
  }
  app.on('login', onLogin)

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void win.loadURL(url)
    } catch {
      // 非 URL / 非 HTTPS：保持拒绝，不交给可能直连的系统浏览器。
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).protocol === 'https:') return
    } catch {
      // fall through
    }
    event.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  win.once('closed', () => {
    app.off('login', onLogin)
    if (windows.get(options.accountKey) === win) windows.delete(options.accountKey)
  })
  await win.loadURL(options.url, { userAgent: stableDesktopUserAgent() })
}

export function closeIsolatedOAuthWindows(): void {
  for (const win of windows.values()) win.destroy()
  windows.clear()
}

function parseElectronProxy(raw: string): { rule: string; username?: string; password?: string } {
  const normalized = normalizeProxyUrl(raw)
  const url = new URL(normalized)
  const username = url.username ? decodeURIComponent(url.username) : undefined
  const password = url.password ? decodeURIComponent(url.password) : undefined
  url.username = ''
  url.password = ''
  return {
    rule: url.toString().replace(/\/$/, ''),
    username,
    password
  }
}

function stableDesktopUserAgent(): string {
  const chrome = process.versions.chrome || '120.0.0.0'
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}
