import type { AppSettings } from '@shared/settings'

/**
 * 配置云同步的「可漫游偏好白名单」投影。
 *
 * 安全红线：只挑非敏感偏好上云。**绝不**包含：
 *  - accounts（含平台凭证/会话/代理）
 *  - sync（登录令牌、服务器地址、邮箱）
 *  - translation 里各引擎的 apiKey（custom/deepl/googleCloud/llm）
 *  - platform.telegramApiHash 等应用级密钥
 * 这些按设计留在各设备本地（凭证不出端、会话与设备绑定）。
 */
export interface SyncableConfig {
  locale: string
  theme: AppSettings['theme']
  translation: {
    engine: string
    inboundEnabled: boolean
    outboundEnabled: boolean
    confirmBeforeSend: boolean
    displayLang: string
    targetLangDefault: string
  }
  notifications: AppSettings['notifications']
  autoReply: AppSettings['autoReply']
}

/** 从完整设置里抽出可上云的偏好子集（不含任何密钥/凭证） */
export function pickSyncable(s: AppSettings): SyncableConfig {
  return {
    locale: s.locale,
    theme: s.theme,
    translation: {
      engine: s.translation.engine,
      inboundEnabled: s.translation.inboundEnabled,
      outboundEnabled: s.translation.outboundEnabled,
      confirmBeforeSend: s.translation.confirmBeforeSend,
      displayLang: s.translation.displayLang,
      targetLangDefault: s.translation.targetLangDefault
    },
    notifications: { ...s.notifications },
    autoReply: { ...s.autoReply }
  }
}

/**
 * 把云端 blob 合并回本地设置，返回 settings.update 用的 patch。
 * 只覆盖白名单字段；translation 做浅合并以保留本地的各引擎 apiKey。
 * 对 blob 逐字段做类型校验，脏数据一律忽略（云端数据也当不可信输入处理）。
 */
export function applySyncable(current: AppSettings, blob: unknown): Partial<AppSettings> {
  if (!blob || typeof blob !== 'object') return {}
  const b = blob as Record<string, unknown>
  const patch: Partial<AppSettings> = {}

  if (typeof b.locale === 'string') patch.locale = b.locale
  if (b.theme === 'light' || b.theme === 'dark' || b.theme === 'system') patch.theme = b.theme

  if (b.translation && typeof b.translation === 'object') {
    const t = b.translation as Record<string, unknown>
    patch.translation = {
      ...current.translation, // 保留本地 apiKey 等敏感子对象
      ...(typeof t.engine === 'string' ? { engine: t.engine } : {}),
      ...(typeof t.inboundEnabled === 'boolean' ? { inboundEnabled: t.inboundEnabled } : {}),
      ...(typeof t.outboundEnabled === 'boolean' ? { outboundEnabled: t.outboundEnabled } : {}),
      ...(typeof t.confirmBeforeSend === 'boolean' ? { confirmBeforeSend: t.confirmBeforeSend } : {}),
      ...(typeof t.displayLang === 'string' ? { displayLang: t.displayLang } : {}),
      ...(typeof t.targetLangDefault === 'string' ? { targetLangDefault: t.targetLangDefault } : {})
    }
  }

  if (b.notifications && typeof b.notifications === 'object') {
    patch.notifications = { ...current.notifications, ...(b.notifications as object) }
  }
  if (b.autoReply && typeof b.autoReply === 'object') {
    patch.autoReply = { ...current.autoReply, ...(b.autoReply as object) }
  }
  return patch
}
