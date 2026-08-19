import type { Logger } from '../core/logger'
import { noopLogger } from '../core/logger'
import type { SyncConfig } from '@shared/settings'

/**
 * 计费接口客户端（套餐/余额/订单/积分）。
 * 与 CampaignApi 同一个模式：复用同步配置里的后台地址与登录令牌，
 * 方法名经 IPC 白名单转发给渲染进程。
 */
export class BillingApi {
  private readonly getConfig: () => SyncConfig
  private readonly log: Logger

  constructor(getConfig: () => SyncConfig, logger: Logger = noopLogger) {
    this.getConfig = getConfig
    this.log = logger.child('billing-api')
  }

  me(): Promise<unknown> {
    return this.request('GET', '/api/billing/me')
  }

  listPlans(): Promise<unknown> {
    return this.request('GET', '/api/billing/plans')
  }

  listChannels(): Promise<unknown> {
    return this.request('GET', '/api/billing/channels')
  }

  listOrders(): Promise<unknown> {
    return this.request('GET', '/api/billing/orders')
  }

  listLedger(): Promise<unknown> {
    return this.request('GET', '/api/billing/ledger')
  }

  createOrder(body: {
    kind: 'topup' | 'plan'
    amountCents?: number
    planId?: string
    channelId: string
  }): Promise<unknown> {
    return this.request('POST', '/api/billing/orders', body)
  }

  subscribe(planId: string): Promise<unknown> {
    return this.request('POST', '/api/billing/subscribe', { planId })
  }

  setAutoRenew(on: boolean): Promise<unknown> {
    return this.request('POST', '/api/billing/auto-renew', { on })
  }

  exchangeCredits(cents: number): Promise<unknown> {
    return this.request('POST', '/api/billing/exchange-credits', { cents })
  }

  // ── 支持工单 ──
  listTickets(): Promise<unknown> {
    return this.request('GET', '/api/support/tickets')
  }

  createTicket(body: { title: string; body: string; mediaId?: string }): Promise<unknown> {
    return this.request('POST', '/api/support/tickets', body)
  }

  getTicket(id: string): Promise<unknown> {
    return this.request('GET', `/api/support/tickets/${encodeURIComponent(id)}`)
  }

  replyTicket(id: string, body: { body: string; mediaId?: string }): Promise<unknown> {
    return this.request('POST', `/api/support/tickets/${encodeURIComponent(id)}/messages`, body)
  }

  closeTicket(id: string): Promise<unknown> {
    return this.request('POST', `/api/support/tickets/${encodeURIComponent(id)}/close`)
  }

  /** 工单贴图：上传本地文件到后台媒体库，返回 mediaId */
  async uploadTicketImage(data: Uint8Array, mimeType: string): Promise<string> {
    const cfg = this.getConfig()
    if (!cfg.serverUrl || !cfg.token) throw new Error('请先登录后台账号')
    const mediaId = `ticket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const res = await fetch(
      `${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': mimeType },
        body: new Uint8Array(data) as unknown as BodyInit
      }
    )
    if (!res.ok) throw new Error(`上传失败（${res.status}）`)
    return mediaId
  }

  /** 拉取受保护媒体（工单里的图） */
  // 返回 base64 data URL 字符串：跨 IPC/contextBridge 传二进制(Uint8Array)会被
  // 结构化克隆损坏(渲染端 Blob 解码 EncodingError)，改传字符串则绝对可靠，
  // 渲染端直接用作 <img src>，无需 Blob/objectURL。
  async fetchMedia(mediaId: string): Promise<{ dataUrl: string }> {
    const cfg = this.getConfig()
    if (!cfg.serverUrl || !cfg.token) throw new Error('未登录后台')
    const res = await fetch(
      `${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
      { headers: { authorization: `Bearer ${cfg.token}` } }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
    const mimeType = res.headers.get('content-type') ?? 'image/png'
    return { dataUrl: `data:${mimeType};base64,${b64}` }
  }

  // ── 团队管理（老板建客服子账号）──
  /** 自己的 userId/角色/权限（团队页展示子账号 @后缀用） */
  myIdentity(): Promise<unknown> {
    return this.request('GET', '/api/me/permissions')
  }


  listTeamMembers(): Promise<unknown> {
    return this.request('GET', '/api/team/members')
  }

  createTeamMember(body: { username: string; password: string; role: string }): Promise<unknown> {
    return this.request('POST', '/api/team/members', body)
  }

  updateTeamMember(
    id: number,
    body: { role?: string; enabled?: boolean; password?: string }
  ): Promise<unknown> {
    return this.request('PATCH', `/api/team/members/${id}`, body)
  }

  deleteTeamMember(id: number): Promise<unknown> {
    return this.request('DELETE', `/api/team/members/${id}`)
  }

  listTeamRoles(): Promise<unknown> {
    return this.request('GET', '/api/team/roles')
  }

  // ── 登录设备（一订阅限 N 台 + 远程下线）──
  listDevices(): Promise<unknown> {
    return this.request('GET', '/api/client/devices')
  }

  revokeDevice(deviceId: string): Promise<unknown> {
    return this.request('POST', '/api/client/devices/revoke', { deviceId })
  }

  createTeamRole(body: { name: string; permissions: string[] }): Promise<unknown> {
    return this.request('POST', '/api/team/roles', body)
  }

  deleteTeamRole(id: string): Promise<unknown> {
    return this.request('DELETE', `/api/team/roles/${encodeURIComponent(id)}`)
  }

  /** 未读通知（公告 + 个人通知，如到期提醒） */
  listNotices(): Promise<unknown> {
    return this.request('GET', '/api/notices')
  }

  markNoticesRead(body: { announcementIds?: string[]; noticeIds?: number[] }): Promise<unknown> {
    return this.request('POST', '/api/notices/read', body)
  }

  /** 自动回复生成：主进程内部使用（AutoReplyService 调用） */
  reply(body: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    system?: string
  }): Promise<{ text: string; credits: number }> {
    return this.request('POST', '/api/ai/reply', body) as Promise<{ text: string; credits: number }>
  }

  /** 语音识别：主进程内部使用（音频文件在主进程），不暴露给渲染进程白名单 */
  transcribe(body: {
    audioBase64: string
    mimeType: string
    durationSec: number
    language?: string
  }): Promise<{ text: string; credits: number }> {
    return this.request('POST', '/api/ai/asr', body) as Promise<{ text: string; credits: number }>
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const cfg = this.getConfig()
    if (!cfg.serverUrl || !cfg.token) {
      throw new Error('请先登录后台账号（套餐与余额保存在后台）')
    }
    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined)
      this.log.warn('计费接口失败', { path, status: res.status, detail })
      throw new Error(detail || `请求失败（${res.status}）`)
    }
    return res.json()
  }
}
