/**
 * 核心层日志接口。核心模块只依赖这个接口（构造注入），
 * 不依赖任何具体日志库 —— pino 实现在 src/main/logging.ts。
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
  /** 派生带作用域前缀的子 logger（如 "whatsapp:main"） */
  child(scope: string): Logger
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  }
}
