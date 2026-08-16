/** 应用设置类型（主进程存储、渲染进程设置页共用） */

export interface TranslationConfig {
  /** 翻译插件 id：google-free（默认，免费）/ deepl / google-cloud / llm / custom-http / off */
  engine: string
  /** 收到客户消息自动译为 displayLang */
  inboundEnabled: boolean
  /** 发送时自动译为客户语言 */
  outboundEnabled: boolean
  /** 发送前显示译文预览，确认后才发出（关闭则直发） */
  confirmBeforeSend: boolean
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
  /** 显示名（默认用登录后的账号名） */
  label?: string
  /**
   * 自定义设备名（WhatsApp「已关联的设备」里显示的浏览器名）。
   * 留空则按账号自动派生一个稳定且各账号不同的设备标识，用于多账号防关联。
   * 改动后需重新登录该账号才会以新设备名重新配对。
   */
  deviceLabel?: string
}

export interface SyncConfig {
  /** 是否把聊天记录同步到后台 */
  enabled: boolean
  /** 后台服务地址，如 https://api.example.com */
  serverUrl: string
  /** 同步鉴权令牌（客户端账号登录后下发） */
  token: string
  /** 登录账号邮箱 */
  email: string
  /** 是否同时上传媒体文件 */
  uploadMedia: boolean
}

export interface AppSettings {
  /** 界面语言 */
  locale: string
  translation: TranslationConfig
  sync: SyncConfig
  /**
   * 按渠道账号 key（如 whatsapp:main）的独立配置。
   * 这里的 key 集合同时是"账号注册表"：启动时为每个 key 创建适配器。
   * whatsapp:main 为固定主账号（不可删除，只能退出登录）。
   */
  accounts: Record<string, AccountConfig>
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  translation: {
    engine: 'google-free',
    inboundEnabled: true,
    outboundEnabled: true,
    confirmBeforeSend: true,
    displayLang: 'zh-CN',
    targetLangDefault: 'en',
    custom: { url: '', apiKey: '' },
    deepl: { apiKey: '' },
    googleCloud: { apiKey: '' },
    llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' }
  },
  sync: { enabled: false, serverUrl: '', token: '', email: '', uploadMedia: true },
  accounts: { 'whatsapp:main': {} }
}
