import type { AuthResult, AuthState } from '@shared/ipc'
import type { Logger } from '../core/logger'
import { noopLogger } from '../core/logger'
import type { SettingsStore } from '../core/settings-store'
import { deviceId, deviceName } from '../core/device-id'

/** 本机设备标识，随登录/注册上报供后台做「一订阅限 N 台」与远程下线 */
function deviceFields(): { deviceId: string; deviceName: string } {
  return { deviceId: deviceId(), deviceName: deviceName() }
}

/**
 * 客户端账号登录（在主进程完成，令牌存入设置的 sync 段并自动启用同步）。
 * 登录成功后，其 token 同时作为同步凭证，聊天记录自动归档到该账号所属租户。
 */
export class ClientAuth {
  private readonly settings: SettingsStore
  private readonly log: Logger
  private email: string | undefined

  constructor(settings: SettingsStore, logger?: Logger) {
    this.settings = settings
    this.log = (logger ?? noopLogger).child('auth')
    this.email = settings.get().sync.email || undefined
  }

  state(): AuthState {
    const sync = this.settings.get().sync
    return {
      authenticated: !!sync.token && !!sync.serverUrl,
      email: this.email,
      serverUrl: sync.serverUrl,
      role: sync.role,
      permissions: sync.permissions
    }
  }

  /**
   * 启动/回前台时刷新权限：老板改了客服的角色，客服下次拉取立即生效。
   * 拿不到就沿用本地缓存（离线也能开界面；服务端才是真正的强制点）。
   */
  async refreshPermissions(): Promise<AuthState> {
    const sync = this.settings.get().sync
    if (sync.token && sync.serverUrl) {
      try {
        const res = await fetch(`${clean(sync.serverUrl)}/api/me/permissions`, {
          headers: { authorization: `Bearer ${sync.token}` },
          signal: AbortSignal.timeout(10_000)
        })
        if (res.ok) {
          const data = (await res.json()) as { role?: string; permissions?: string[] }
          await this.settings.update({
            sync: { ...sync, role: data.role, permissions: data.permissions }
          })
        } else if (res.status === 401) {
          // 会话被吊销（例如子账号被停用）：清掉本地登录态
          this.email = undefined
          await this.settings.update({
            sync: { ...sync, token: '', email: '', enabled: false }
          })
        }
      } catch {
        // 离线：保留缓存
      }
    }
    return this.state()
  }

  async config(serverUrl: string): Promise<{ requireEmailVerify: boolean } | { error: string }> {
    try {
      const res = await fetch(`${clean(serverUrl)}/api/client/config`, {
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return (await res.json()) as { requireEmailVerify: boolean }
    } catch (err) {
      return { error: `无法连接后台：${String(err)}` }
    }
  }

  async sendCode(serverUrl: string, email: string): Promise<AuthResult> {
    return this.post(serverUrl, '/api/client/send-code', { email })
  }

  async register(
    serverUrl: string,
    email: string,
    password: string,
    code?: string,
    inviteCode?: string
  ): Promise<AuthResult> {
    return this.authFlow(
      serverUrl,
      '/api/client/register',
      { email, password, code, inviteCode: inviteCode?.trim() || undefined, ...deviceFields() },
      email
    )
  }

  async forgotPassword(serverUrl: string, email: string): Promise<AuthResult> {
    return this.post(serverUrl, '/api/client/forgot-password', { email })
  }

  async resetPassword(
    serverUrl: string,
    email: string,
    code: string,
    password: string
  ): Promise<AuthResult> {
    return this.post(serverUrl, '/api/client/reset-password', { email, code, password })
  }

  async login(serverUrl: string, email: string, password: string): Promise<AuthResult> {
    return this.authFlow(
      serverUrl,
      '/api/client/login',
      { email, password, ...deviceFields() },
      email
    )
  }

  async logout(): Promise<void> {
    const sync = this.settings.get().sync
    if (sync.token && sync.serverUrl) {
      await fetch(`${clean(sync.serverUrl)}/api/client/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sync.token}` }
      }).catch(() => undefined)
    }
    this.email = undefined
    await this.settings.update({
      sync: { ...sync, token: '', email: '', enabled: false }
    })
  }

  /** 登录/注册成功：存 token+serverUrl 并自动开启同步 */
  private async authFlow(
    serverUrl: string,
    path: string,
    body: Record<string, unknown>,
    email: string
  ): Promise<AuthResult> {
    const r = await this.post(serverUrl, path, body)
    if (!r.ok) return r
    const token = (r as { token?: string }).token
    if (!token) return { ok: false, error: '后台未返回令牌' }
    const user = (r as { user?: { role?: string; permissions?: string[] } }).user
    this.email = email
    const sync = this.settings.get().sync
    await this.settings.update({
      sync: {
        ...sync,
        serverUrl: clean(serverUrl),
        token,
        email,
        enabled: true,
        role: user?.role,
        permissions: user?.permissions
      }
    })
    this.log.info('客户端账号登录成功', { email })
    return { ok: true }
  }

  private async post(
    serverUrl: string,
    path: string,
    body: Record<string, unknown>
  ): Promise<AuthResult & { token?: string; user?: { role?: string; permissions?: string[] } }> {
    try {
      const res = await fetch(`${clean(serverUrl)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        token?: string
        user?: { role?: string; permissions?: string[] }
      }
      if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` }
      return { ok: true, token: data.token, user: data.user }
    } catch (err) {
      return { ok: false, error: `无法连接后台：${String(err)}` }
    }
  }
}

function clean(url: string): string {
  return url.trim().replace(/\/$/, '')
}
