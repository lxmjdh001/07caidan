export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

interface WindowState {
  count: number
  resetAt: number
}

/**
 * 进程内固定窗口限流器。服务当前是单实例 systemd 部署，进程内状态即可覆盖公网入口；
 * 同时限制表大小，避免攻击者用大量伪造键制造内存增长。
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>()
  private readonly maxKeys: number

  constructor(maxKeys = 20_000) {
    this.maxKeys = maxKeys
  }

  check(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
    const state = this.windows.get(key)
    if (!state || state.resetAt <= now) {
      if (state) this.windows.delete(key)
      return { allowed: true, remaining: limit, retryAfterSeconds: Math.ceil(windowMs / 1000) }
    }
    return {
      allowed: state.count < limit,
      remaining: Math.max(0, limit - state.count),
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000))
    }
  }

  reset(key: string): void {
    this.windows.delete(key)
  }

  consume(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
    let state = this.windows.get(key)
    if (!state || state.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now)
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value as string | undefined
        if (oldest) this.windows.delete(oldest)
      }
      state = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, state)
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - now) / 1000))
    if (state.count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds }
    state.count += 1
    return { allowed: true, remaining: Math.max(0, limit - state.count), retryAfterSeconds }
  }

  private prune(now: number): void {
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key)
    }
  }
}
