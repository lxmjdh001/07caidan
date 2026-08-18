import type { Analyzer } from './analyzer.ts'
import type { IntentRepo } from './intent-repo.ts'
import type { Repo } from './repo.ts'

export interface AutoTaggerOptions {
  analyzer?: Analyzer
  /** 总开关（config.autoTag）；关或无 analyzer 时 tag() 直接跳过 */
  enabled: boolean
  /** 单次最多分析多少个会话，避免一次同步触发大量调用 */
  maxPerRun?: number
  logger?: { info: (m: string, x?: unknown) => void; debug: (m: string, x?: unknown) => void }
}

/**
 * 实时自动打标签（M5）。
 * /api/sync 收到入站消息后调用；对有更新入站的会话按需重算意向并落库。
 * 设计要点：非阻塞（sync 不等它）；needsRetag 天然节流（同状态不重复算）；
 * 单次 maxPerRun 上限防止一次大批同步打爆分析后端。
 */
export class AutoTagger {
  private readonly repo: Repo
  private readonly intents: IntentRepo
  private readonly opts: AutoTaggerOptions

  constructor(repo: Repo, intents: IntentRepo, opts: AutoTaggerOptions) {
    this.repo = repo
    this.intents = intents
    this.opts = opts
  }

  get active(): boolean {
    return this.opts.enabled && !!this.opts.analyzer
  }

  /** 最新入站消息时间（无入站返回 0） */
  private newestInboundAt(tenant: string, conversationId: string): number {
    const msgs = this.repo.listMessages(tenant, conversationId, 500)
    let t = 0
    for (const m of msgs) if (m.direction === 'in' && m.timestamp > t) t = m.timestamp
    return t
  }

  /**
   * 对给定会话按需打标签。返回实际分析的会话数。
   * 群聊会话由调用方决定是否传入（此处不额外过滤）。
   */
  async tag(tenant: string, conversationIds: string[]): Promise<number> {
    if (!this.active) return 0
    const analyzer = this.opts.analyzer!
    const max = this.opts.maxPerRun ?? 20
    const unique = [...new Set(conversationIds)]
    let done = 0
    for (const id of unique) {
      if (done >= max) break
      const newest = this.newestInboundAt(tenant, id)
      if (!this.intents.needsRetag(tenant, id, newest)) continue
      try {
        const analysis = await analyzer.analyze(this.repo.listMessages(tenant, id, 500))
        this.intents.put(tenant, id, analysis, newest)
        done++
      } catch (err) {
        this.opts.logger?.debug('自动打标签失败', { id, err: String(err) })
      }
    }
    if (done > 0) this.opts.logger?.info('自动打标签完成', { count: done })
    return done
  }
}
