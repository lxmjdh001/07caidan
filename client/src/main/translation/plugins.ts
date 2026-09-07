import type { TranslationConfig } from '@shared/settings'
import { PassthroughTranslator } from './passthrough-translator'
import type { TranslationPipeline } from './pipeline'
import { CustomHttpTranslator, type CustomHttpConfig } from './providers/custom-http'
import { DeepLTranslator, type DeepLConfig } from './providers/deepl'
import { GoogleCloudTranslator, type GoogleCloudConfig } from './providers/google-cloud'
import { AiServerTranslator, type AiServerConfig } from './providers/ai-server'
import { GoogleFreeTranslator } from './providers/google-free'
import { LlmTranslator, type LlmConfig } from './providers/llm'
import { TranslatorRegistry } from './registry'

/** 内置翻译插件。新增引擎在此注册即可出现在设置页。 */
export function createTranslatorRegistry(): TranslatorRegistry {
  const registry = new TranslatorRegistry()

  registry.register({
    id: 'google-free',
    displayName: 'Google 翻译',
    create: () => new GoogleFreeTranslator()
  })

  registry.register({
    id: 'deepl',
    displayName: 'DeepL',
    create: (config) => new DeepLTranslator(config as unknown as DeepLConfig)
  })

  registry.register({
    id: 'google-cloud',
    displayName: 'Google Cloud Translation',
    create: (config) => new GoogleCloudTranslator(config as unknown as GoogleCloudConfig)
  })

  registry.register({
    id: 'llm',
    displayName: 'LLM 翻译',
    create: (config) => new LlmTranslator(config as unknown as LlmConfig)
  })

  registry.register({
    id: 'custom-http',
    displayName: '自定义接口',
    create: (config) => new CustomHttpTranslator(config as unknown as CustomHttpConfig)
  })

  registry.register({
    id: 'ai-server',
    displayName: 'AI 翻译',
    create: (config) =>
      new AiServerTranslator({
        ...(config as unknown as AiServerConfig),
        // 积分不足 / 未配模型 / 网络故障时回落免费引擎，翻译永远尽力而为
        fallback: new GoogleFreeTranslator()
      })
  })

  registry.register({
    id: 'off',
    displayName: '关闭翻译',
    create: () => new PassthroughTranslator()
  })

  return registry
}

/** 各引擎从设置中取各自的配置段 */
function engineConfig(cfg: TranslationConfig, engine: string): Record<string, unknown> {

  switch (engine) {
    case 'custom-http':
      return { url: cfg.custom.url, apiKey: cfg.custom.apiKey }
    case 'deepl':
      return { apiKey: cfg.deepl.apiKey }
    case 'google-cloud':
      return { apiKey: cfg.googleCloud.apiKey }
    case 'llm':
      return { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, model: cfg.llm.model }
    default:
      return {}
  }
}

/** 按用户设置装配翻译管道（引擎创建失败时降级为关闭，不阻塞收发） */
export interface PipelineExtras {
  /** ai-server 引擎需要的后台地址与令牌（来自 sync 配置，与翻译设置解耦） */
  getBackend?: () => { serverUrl?: string; token?: string }
}

export function configurePipeline(
  pipeline: TranslationPipeline,
  registry: TranslatorRegistry,
  cfg: TranslationConfig,
  extras: PipelineExtras = {}
): void {
  const engine = cfg.engine || 'google-free'
  let translator
  try {
    const config =
      engine === 'ai-server'
        ? { getBackend: extras.getBackend ?? (() => ({})) }
        : engineConfig(cfg, engine)
    translator = registry.create(engine, config)
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
