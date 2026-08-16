import type { Translator } from './translator'

/**
 * 翻译引擎插件。新增引擎（DeepL、LLM 等）= 实现 create 并在 plugins/index 注册。
 * config 来自用户设置，由各引擎自行解释。
 */
export interface TranslatorPlugin {
  id: string
  displayName: string
  create(config: Record<string, unknown>): Translator
}

export class TranslatorRegistry {
  private readonly plugins = new Map<string, TranslatorPlugin>()

  register(plugin: TranslatorPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`翻译插件重复注册: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
  }

  create(id: string, config: Record<string, unknown> = {}): Translator {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`未注册的翻译插件: ${id}`)
    return plugin.create(config)
  }

  list(): Array<{ id: string; displayName: string }> {
    return [...this.plugins.values()].map(({ id, displayName }) => ({ id, displayName }))
  }
}
