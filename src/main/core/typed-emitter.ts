import { EventEmitter } from 'node:events'

/**
 * 类型安全的事件发射器。E 的每个 key 是事件名，value 是监听器参数元组。
 */
export class TypedEmitter<E extends Record<string, unknown[]>> {
  private readonly emitter = new EventEmitter()

  on<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  off<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
    return this
  }

  emit<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
    return this.emitter.emit(event, ...args)
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners()
    return this
  }
}
