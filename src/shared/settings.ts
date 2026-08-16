/** 应用设置类型（主进程存储、渲染进程设置页共用） */

export interface TranslationConfig {
  /** 翻译插件 id：google-free（默认，免费）/ deepl / google-cloud / llm / custom-http / off */
  engine: string
  /** 收到客户消息自动译为 displayLang */
  inboundEnabled: boolean
  /** 发送时自动译为客户语言 */
  outboundEnabled: boolean
  /** 坐席本地语言（收到的消息译成这个） */
  displayLang: string
  /** 全局默认客户语言：未识别到客户语言且账号未配置时使用 */
  targetLangDefault: string
  /** 各引擎配置 */
  custom: { url: string; apiKey: string }
  deepl: { apiKey: string }
  googleCloud: { apiKey: string }
  llm: { baseUrl: string; apiKey: string; model: string }
}

export interface AccountConfig {
  /** 该账号的代理，如 socks5://127.0.0.1:1080；留空走默认网络 */
  proxyUrl?: string
  /** 该账号的默认客户语言（覆盖全局 targetLangDefault）；留空跟随全局 */
  defaultLang?: string
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
    outboundEnabled: true,
    displayLang: 'zh-CN',
    targetLangDefault: 'en',
    custom: { url: '', apiKey: '' },
    deepl: { apiKey: '' },
    googleCloud: { apiKey: '' },
    llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' }
  },
  accounts: {}
}
