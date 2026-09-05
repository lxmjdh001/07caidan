import type { AppSettings, QuickReply } from '@shared/settings'
import type { ChannelKind } from '@shared/domain'

const PLATFORM_KINDS: readonly ChannelKind[] = [
  'whatsapp',
  'telegram',
  'telegram_bot',
  'line',
  'kakaotalk',
  'facebook',
  'instagram',
  'tiktok',
  'x',
  'snapchat'
]

/**
 * 配置云同步的「可漫游偏好白名单」投影。
 *
 * 安全红线：只挑非敏感偏好上云。**绝不**包含：
 *  - accounts（含平台凭证/会话/代理关联）与 proxyAssets（含代理认证信息）
 *  - sync（登录令牌、服务器地址、邮箱）
 *  - translation 里各引擎的 apiKey（custom/deepl/googleCloud/llm）
 *  - platform.telegramApiHash 等应用级密钥
 * 这些按设计留在各设备本地（凭证不出端、会话与设备绑定）。
 */
export interface SyncableConfig {
  locale: string
  theme: AppSettings['theme']
  platformOrder: ChannelKind[]
  translation: {
    engine: string
    inboundEnabled: boolean
    outboundEnabled: boolean
    confirmBeforeSend: boolean
    displayLang: string
    targetLangDefault: string
  }
  notifications: AppSettings['notifications']
  quickReplies: QuickReply[]
  autoReply: AppSettings['autoReply']
}

/** 快捷消息不含凭证，可以跨设备同步；仍按不可信输入限制数量与字段长度。 */
function sanitizeQuickReplies(value: unknown): QuickReply[] {
  if (!Array.isArray(value)) return []
  const replies: QuickReply[] = []
  const ids = new Set<string>()
  for (const candidate of value.slice(0, 200)) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : ''
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 4000) : ''
    if (!id || !text || ids.has(id)) continue
    ids.add(id)
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 80) : ''
    const category = typeof item.category === 'string' ? item.category.trim().slice(0, 50) : ''
    replies.push({
      id,
      title: title || text.slice(0, 40),
      text,
      ...(category ? { category } : {})
    })
  }
  return replies
}

/** 可跨设备恢复的账号目录条目；刻意不包含任何设备或认证字段。 */
export interface SyncableAccount {
  accountKey: string
  channel: ChannelKind
  accountId: string
  label?: string
  defaultLang?: string
}

/**
 * 账号壳单独逐条同步，避免偏好设置的整包后写覆盖造成多设备新增账号互相丢失。
 * 代理、指纹、验证结果、deviceLabel、credentials 都不在返回值中。
 */
export function pickSyncableAccounts(s: AppSettings): SyncableAccount[] {
  const result: SyncableAccount[] = []
  for (const [accountKey, config] of Object.entries(s.accounts)) {
    const separator = accountKey.indexOf(':')
    if (separator <= 0) continue
    const channel = accountKey.slice(0, separator) as ChannelKind
    const accountId = accountKey.slice(separator + 1)
    if (!PLATFORM_KINDS.includes(channel) || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) continue
    result.push({
      accountKey,
      channel,
      accountId,
      ...(config.label?.trim() ? { label: config.label.trim() } : {}),
      ...(config.defaultLang?.trim() ? { defaultLang: config.defaultLang.trim() } : {})
    })
  }
  return result.sort((a, b) => a.accountKey.localeCompare(b.accountKey))
}

/** 从完整设置里抽出可上云的偏好子集（不含任何密钥/凭证） */
export function pickSyncable(s: AppSettings): SyncableConfig {
  return {
    locale: s.locale,
    theme: s.theme,
    platformOrder: [...s.platformOrder],
    translation: {
      engine: s.translation.engine,
      inboundEnabled: s.translation.inboundEnabled,
      outboundEnabled: s.translation.outboundEnabled,
      confirmBeforeSend: s.translation.confirmBeforeSend,
      displayLang: s.translation.displayLang,
      targetLangDefault: s.translation.targetLangDefault
    },
    notifications: { ...s.notifications },
    quickReplies: sanitizeQuickReplies(s.quickReplies),
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
  if (Array.isArray(b.platformOrder)) {
    const order = b.platformOrder.filter(
      (kind): kind is ChannelKind => typeof kind === 'string' && PLATFORM_KINDS.includes(kind as ChannelKind)
    )
    if (order.length > 0 && new Set(order).size === order.length) {
      // 云端可能由旧客户端写入，缺少后来增加的平台；保留用户原顺序并补到末尾。
      patch.platformOrder = [...order, ...PLATFORM_KINDS.filter((kind) => !order.includes(kind))]
    }
  }

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
  if (Array.isArray(b.quickReplies)) {
    patch.quickReplies = sanitizeQuickReplies(b.quickReplies)
  }
  if (b.autoReply && typeof b.autoReply === 'object') {
    patch.autoReply = { ...current.autoReply, ...(b.autoReply as object) }
  }
  return patch
}
