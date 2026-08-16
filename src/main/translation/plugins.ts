import type { TranslationConfig } from '@shared/settings'
import { PassthroughTranslator } from './passthrough-translator'
import type { TranslationPipeline } from './pipeline'
import { CustomHttpTranslator, type CustomHttpConfig } from './providers/custom-http'
import { GoogleFreeTranslator } from './providers/google-free'
import { TranslatorRegistry } from './registry'

/** 内置翻译插件。新增引擎在此注册即可出现在设置页。 */
export function createTranslatorRegistry(): TranslatorRegistry {
  const registry = new TranslatorRegistry()

  registry.register({
    id: 'google-free',
    displayName: 'Google 翻译（免费）',
    create: () => new GoogleFreeTranslator()
  })

  registry.register({
    id: 'custom-http',
    displayName: '自定义接口',
    create: (config) => new CustomHttpTranslator(config as unknown as CustomHttpConfig)
  })

  registry.register({
    id: 'off',
    displayName: '关闭翻译',
    create: () => new PassthroughTranslator()
  })

  return registry
}

/** 按用户设置装配翻译管道（引擎创建失败时降级为关闭，不阻塞收发） */
export function configurePipeline(
  pipeline: TranslationPipeline,
  registry: TranslatorRegistry,
  cfg: TranslationConfig
): void {
  const engine = cfg.engine || 'google-free'
  let translator
  try {
    translator = registry.create(
      engine,
      engine === 'custom-http' ? { url: cfg.custom.url, apiKey: cfg.custom.apiKey } : {}
    )
  } catch {
    translator = registry.create('off')
  }
  pipeline.setTranslator(translator)
  pipeline.updateSettings({
    inboundEnabled: engine !== 'off' && cfg.inboundEnabled,
    outboundEnabled: engine !== 'off' && cfg.outboundEnabled,
    displayLang: cfg.displayLang
  })
}
