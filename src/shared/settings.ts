/** 应用设置类型（主进程存储、渲染进程设置页共用） */

export interface TranslationConfig {
  /** 翻译插件 id：google-free（默认，免费）/ custom-http / off */
  engine: string
  inboundEnabled: boolean
  outboundEnabled: boolean
  /** 坐席阅读语言 */
  displayLang: string
  /** custom-http 引擎的配置 */
  custom: { url: string; apiKey: string }
}

export interface AccountConfig {
  /** 该账号的代理，如 socks5://127.0.0.1:1080；留空走默认网络 */
  proxyUrl?: string
}

export interface AppSettings {
  /** 界面语言 */
  locale: string
  translation: TranslationConfig
  /** 按渠道账号 key（如 whatsapp:main）的独立配置 */
  accounts: Record<string, AccountConfig>
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  translation: {
    engine: 'google-free',
    inboundEnabled: true,
    outboundEnabled: false,
    displayLang: 'zh-CN',
    custom: { url: '', apiKey: '' }
  },
  accounts: {}
}
