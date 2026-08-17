import type { SyncConfig } from '@shared/settings'
import type { Logger } from './logger'

export type UploadLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<UploadLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

interface Entry {
  level: UploadLevel
  scope: string
  message: string
  meta?: unknown
  at: number
}

export interface LogUploaderOptions {
  /** 后台地址与令牌来自同步配置；未登录（游客）也上报，只是不带令牌 */
  getConfig: () => Pick<SyncConfig, 'serverUrl' | 'token'>
  deviceId: string
  appVersion: string
  osType: string
  osVersion: string
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch
  /** 定时冲刷间隔（毫秒） */
  flushIntervalMs?: number
}

/** 缓冲上限：后台长时间不可达时丢最旧的，不能无限吃内存 */
const BUFFER_MAX = 500
/** 攒到这个数量立即冲刷，不等定时器 */
const FLUSH_AT = 50
/** 单批上限（与服务端 BATCH_MAX 对齐） */
const BATCH = 200

/**
 * 日志上传器（M19）。
 *
 * 挂在本地 pino 之外的第二条通路：达到门槛级别的日志进内存缓冲，
 * 定时/攒批冲刷到后台。失败不丢（保留重试），后台响应里带回
 * 管理员为该用户设置的级别，动态调整门槛 —— 排障时管理后台把某个
 * 用户调到 debug，客户端下一批上报后自动放开。
 */
export class LogUploader {
  private readonly opts: LogUploaderOptions
  private readonly fetchImpl: typeof fetch
  private buffer: Entry[] = []
  private level: UploadLevel = 'warn'
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(opts: LogUploaderOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  currentLevel(): UploadLevel {
    return this.level
  }

  pending(): number {
    return this.buffer.length
  }

  add(level: UploadLevel, scope: string, message: string, meta?: unknown): void {
    if (RANK[level] < RANK[this.level]) return
    this.buffer.push({ level, scope, message, meta, at: Date.now() })
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX)
    if (this.buffer.length >= FLUSH_AT) void this.flush()
  }

  /** 冲刷缓冲。失败保留待下次重试；成功后按响应调整门槛级别。 */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return
    const cfg = this.opts.getConfig()
    if (!cfg.serverUrl) return
    this.flushing = true
    const batch = this.buffer.slice(0, BATCH)
    try {
      const res = await this.fetchImpl(`${cfg.serverUrl.replace(/\/$/, '')}/api/logs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
        },
        body: JSON.stringify({
          deviceId: this.opts.deviceId,
          appVersion: this.opts.appVersion,
          osType: this.opts.osType,
          osVersion: this.opts.osVersion,
          entries: batch
        }),
        signal: AbortSignal.timeout(15_000)
      })
      if (res.ok) {
        this.buffer.splice(0, batch.length)
        const data = (await res.json().catch(() => ({}))) as { level?: string }
        if (data.level && data.level in RANK) this.level = data.level as UploadLevel
      }
      // 非 2xx：保留缓冲，下一轮重试
    } catch {
      // 网络失败：保留缓冲，静默等下一轮 —— 日志通路自己不能再产生日志噪音
    } finally {
      this.flushing = false
    }
  }
}

/**
 * 把上传器叠在现有 Logger 之上：所有日志照常走本地 pino，
 * 同时喂给上传器（按门槛过滤）。核心模块无感知。
 */
export function teeLogger(base: Logger, uploader: LogUploader, scope = ''): Logger {
  return {
    debug: (msg, meta) => {
      base.debug(msg, meta)
      uploader.add('debug', scope, msg, meta)
    },
    info: (msg, meta) => {
      base.info(msg, meta)
      uploader.add('info', scope, msg, meta)
    },
    warn: (msg, meta) => {
      base.warn(msg, meta)
      uploader.add('warn', scope, msg, meta)
    },
    error: (msg, meta) => {
      base.error(msg, meta)
      uploader.add('error', scope, msg, serializeMeta(meta))
    },
    child: (sub) => teeLogger(base.child(sub), uploader, scope ? `${scope}:${sub}` : sub)
  }
}

function serializeMeta(meta: unknown): unknown {
  if (meta instanceof Error) return { name: meta.name, message: meta.message, stack: meta.stack }
  return meta
}
