import type { Logger } from '../core/logger'
import { noopLogger } from '../core/logger'
import type { SyncConfig } from '@shared/settings'
import type {
  Campaign,
  CampaignInput,
  CampaignLink,
  CampaignStatsResult,
  FanLibrary,
  ImportResult,
  LinkOptions
} from '@shared/campaign'

/**
 * 工单 / 重粉库的后台接口客户端。
 *
 * 老板的所有操作都在客户端进行（建工单、配判重、发分享链接），
 * 数据落在后台是因为看板要能被团队公开访问，客户端关掉了也得能看。
 * 复用同步配置里的后台地址与登录令牌 —— 没登录后台就用不了工单。
 */
export class CampaignApi {
  private readonly getConfig: () => SyncConfig
  private readonly log: Logger

  constructor(getConfig: () => SyncConfig, logger: Logger = noopLogger) {
    this.getConfig = getConfig
    this.log = logger.child('campaign-api')
  }

  /** 是否具备调用条件（未登录后台时 UI 要给出明确提示而不是报网络错） */
  available(): boolean {
    const cfg = this.getConfig()
    return Boolean(cfg.serverUrl && cfg.token)
  }

  // ── 工单 ──

  listCampaigns(): Promise<Campaign[]> {
    return this.request<{ campaigns: Campaign[] }>('GET', '/api/campaigns').then((r) => r.campaigns)
  }

  createCampaign(input: CampaignInput): Promise<Campaign> {
    return this.request<{ campaign: Campaign }>('POST', '/api/campaigns', input).then(
      (r) => r.campaign
    )
  }

  updateCampaign(id: string, patch: Partial<CampaignInput>): Promise<void> {
    return this.request('PATCH', `/api/campaigns/${encodeURIComponent(id)}`, patch).then(() => {})
  }

  /** 上传工单账号头像，返回后台媒体库 ID，供公开分享页读取。 */
  async uploadAvatar(data: Uint8Array, mimeType: string): Promise<string> {
    const cfg = this.getConfig()
    if (!cfg.serverUrl || !cfg.token) throw new Error('请先登录后台账号')
    const mediaId = `campaign-avatar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let res: Response
    try {
      res = await fetch(
        `${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': mimeType || 'image/png' },
          body: new Uint8Array(data) as unknown as BodyInit,
          signal: AbortSignal.timeout(15_000)
        }
      )
    } catch (error) {
      this.log.warn('账号头像上传连接失败', { serverUrl: cfg.serverUrl, error: String(error) })
      throw new Error('后台服务连接失败，请检查后台地址和服务是否已启动')
    }
    if (!res.ok) throw new Error(`头像上传失败（${res.status}）`)
    return mediaId
  }

  deleteCampaign(id: string): Promise<void> {
    return this.request('DELETE', `/api/campaigns/${encodeURIComponent(id)}`).then(() => {})
  }

  campaignStats(id: string): Promise<CampaignStatsResult> {
    return this.request<CampaignStatsResult>('GET', `/api/campaigns/${encodeURIComponent(id)}/stats`)
  }


  // ── 分享链接 ──

  listLinks(campaignId: string): Promise<{ links: CampaignLink[]; publicBase: string }> {
    return this.request(`GET`, `/api/campaigns/${encodeURIComponent(campaignId)}/links`)
  }

  createLink(campaignId: string, opts: LinkOptions = {}): Promise<{ link: CampaignLink; url: string }> {
    return this.request('POST', `/api/campaigns/${encodeURIComponent(campaignId)}/links`, opts)
  }

  listEntryLinks(): Promise<unknown> {
    return this.request('GET', '/api/entry-links')
  }

  createEntryLink(body: {
    name: string
    channel: string
    accountId: string
    handle: string
    code: string
    greeting?: string
  }): Promise<unknown> {
    return this.request('POST', '/api/entry-links', body)
  }

  deleteEntryLink(id: string): Promise<unknown> {
    return this.request('DELETE', `/api/entry-links/${encodeURIComponent(id)}`)
  }

  revokeLink(token: string): Promise<void> {
    return this.request('POST', `/api/campaigns/links/${encodeURIComponent(token)}/revoke`).then(
      () => {}
    )
  }

  restoreLink(token: string): Promise<void> {
    return this.request('POST', `/api/campaigns/links/${encodeURIComponent(token)}/restore`).then(
      () => {}
    )
  }

  deleteLink(token: string): Promise<void> {
    return this.request('DELETE', `/api/campaigns/links/${encodeURIComponent(token)}`).then(() => {})
  }

  // ── 重粉库 ──

  listLibraries(): Promise<FanLibrary[]> {
    return this.request<{ libraries: FanLibrary[] }>('GET', '/api/fan-libraries').then(
      (r) => r.libraries
    )
  }

  importLibrary(body: {
    name: string
    channel: string
    contacts: string
    lineProvider?: string
  }): Promise<ImportResult> {
    return this.request('POST', '/api/fan-libraries/import', body)
  }

  exportLibrary(body: {
    name: string
    channel: string
    accountIds?: string[]
    from?: number
    to?: number
  }): Promise<{ library: FanLibrary; added: number }> {
    return this.request('POST', '/api/fan-libraries/export', body)
  }

  appendEntries(id: string, contacts: string, lineProvider?: string): Promise<ImportResult> {
    return this.request('POST', `/api/fan-libraries/${encodeURIComponent(id)}/entries`, {
      contacts,
      lineProvider
    })
  }

  deleteLibrary(id: string): Promise<void> {
    return this.request('DELETE', `/api/fan-libraries/${encodeURIComponent(id)}`).then(() => {})
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const cfg = this.getConfig()
    if (!cfg.serverUrl || !cfg.token) {
      throw new Error('请先登录后台账号（工单数据保存在后台，看板才能公开访问）')
    }
    let res: Response
    try {
      res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000)
      })
    } catch (error) {
      this.log.warn('工单后台连接失败', { path, serverUrl: cfg.serverUrl, error: String(error) })
      throw new Error('后台服务连接失败，请检查后台地址和服务是否已启动')
    }
    if (!res.ok) {
      // 后台会带上人话错误信息，优先透传给用户
      const detail = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined)
      this.log.warn('工单接口失败', { path, status: res.status, detail })
      throw new Error(detail || `请求失败（${res.status}）`)
    }
    return (await res.json()) as T
  }
}
