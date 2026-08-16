import { noopLogger, type Logger } from '../../core/logger'

export interface LinePollBackend {
  url?: string
  token?: string
}

type EventHandler = (events: unknown[]) => void

const POLL_INTERVAL_MS = 5000

/**
 * LINE 事件轮询协调器 —— 整机单例。
 *
 * 此前每个 LINE 账号各开一个 5 秒定时器单独拉后台，1000 个账号
 * 就是 200 req/s 的空轮询，先把自己的后台压垮。改成所有账号共享
 * 一个定时器、一次 /api/line/pull-all 拿回全部账号的事件再分发，
 * 请求量与账号数彻底解耦（1000 账号仍是 0.2 req/s）。
 */
export class LinePollCoordinator {
  private readonly getBackend: () => LinePollBackend
  private readonly log: Logger
  private readonly handlers = new Map<string, EventHandler>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false

  private readonly fetchImpl: typeof fetch

  constructor(
    getBackend: () => LinePollBackend,
    logger: Logger = noopLogger,
    fetchImpl: typeof fetch = fetch
  ) {
    this.getBackend = getBackend
    this.log = logger.child('line-poll')
    this.fetchImpl = fetchImpl
  }

  /** 账号上线注册；第一个注册者启动定时器 */
  register(accountId: string, handler: EventHandler): void {
    this.handlers.set(accountId, handler)
    if (!this.timer) {
      // 不做注册时的立即拉取：与手动 poll 抢并发锁会引入竞态，
      // 首批事件最多晚一个周期，换取行为完全可预测
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /** 账号下线注销；最后一个走时停掉定时器 */
  unregister(accountId: string): void {
    this.handlers.delete(accountId)
    if (this.handlers.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 单轮拉取并分发（测试可直接调用；fetch 由构造器注入） */
  async poll(): Promise<void> {
    const fetchImpl = this.fetchImpl
    if (this.polling || this.handlers.size === 0) return
    const { url, token } = this.getBackend()
    if (!url || !token) return
    this.polling = true
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/line/pull-all`, {
        headers: { authorization: `Bearer ${token}` }
      })
      if (!res.ok) return
      const { events } = (await res.json()) as { events?: Record<string, unknown[]> }
      for (const [accountId, list] of Object.entries(events ?? {})) {
        const handler = this.handlers.get(accountId)
        if (!handler || !Array.isArray(list) || list.length === 0) continue
        try {
          handler(list)
        } catch (err) {
          // 单个账号的处理失败不能影响其它账号的分发
          this.log.warn('事件分发失败', { accountId, err: String(err) })
        }
      }
    } catch (err) {
      this.log.debug('轮询失败，下轮重试', { err: String(err) })
    } finally {
      this.polling = false
    }
  }

  /** 当前注册的账号数（测试/诊断用） */
  size(): number {
    return this.handlers.size
  }
}
