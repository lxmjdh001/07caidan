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
