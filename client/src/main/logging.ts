import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import type { Logger } from './core/logger'

/**
 * pino 实现：同时写入 stdout（开发时看）和 logs/omnichat.log（用户排障时取）。
 */
export function initLogging(logDir: string): Logger {
  mkdirSync(logDir, { recursive: true })
  const root = pino(
    { level: 'debug' },
    pino.multistream([
      { level: 'info', stream: process.stdout },
      { level: 'debug', stream: pino.destination({ dest: join(logDir, 'omnichat.log'), mkdir: true }) }
    ])
  )
  return wrap(root)
}

function wrap(p: pino.Logger): Logger {
  return {
    debug: (msg, meta) => (meta === undefined ? p.debug(msg) : p.debug({ meta }, msg)),
    info: (msg, meta) => (meta === undefined ? p.info(msg) : p.info({ meta }, msg)),
    warn: (msg, meta) => (meta === undefined ? p.warn(msg) : p.warn({ meta }, msg)),
    error: (msg, meta) => (meta === undefined ? p.error(msg) : p.error({ meta: serializeError(meta) }, msg)),
    child: (scope) => wrap(p.child({ scope }))
  }
}

function serializeError(meta: unknown): unknown {
  if (meta instanceof Error) {
    return { name: meta.name, message: meta.message, stack: meta.stack }
  }
  return meta
}
