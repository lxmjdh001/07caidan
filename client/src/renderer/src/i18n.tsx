import { createContext, useContext, type ReactNode } from 'react'
import { ar } from './locales/ar'
import { en } from './locales/en'
import { es } from './locales/es'
import { id } from './locales/id'
import { ja } from './locales/ja'
import { ko } from './locales/ko'
import { ms } from './locales/ms'
import { ptBR } from './locales/pt-BR'
import { th } from './locales/th'
import { vi } from './locales/vi'
import { zhCN, type MessageKey } from './locales/zh-CN'
import { zhTW } from './locales/zh-TW'

export type { MessageKey }

/**
 * 轻量 i18n：字典 + Context。
 *
 * 语言覆盖以跨境引流的主要目标市场为准：中文（简/繁）、英语、日语、韩语、
 * 越南语、泰语、马来语、印尼语、西班牙语、葡萄牙语（巴西）、阿拉伯语。
 *
 * 新增语言 = locales/ 下加一个文件 + 在 dictionaries 与 LOCALES 各加一行。
 * 字典类型是 Partial：缺的 key 自动回落英语，不会因为漏翻一句就编译不过。
 */
export const dictionaries = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  vi,
  th,
  ms,
  id,
  es,
  'pt-BR': ptBR,
  ar
} as const

export type Locale = keyof typeof dictionaries

/** 文字方向；阿拉伯语等需要整体镜像布局 */
export type Direction = 'ltr' | 'rtl'

export interface LocaleMeta {
  code: Locale
  /** 用该语言自己的写法展示（用户在陌生界面里也能认出母语） */
  nativeName: string
  dir: Direction
  /** 系统语言匹配用的前缀，如 zh-Hant / ja */
  matches: string[]
}

export const LOCALES: LocaleMeta[] = [
  { code: 'zh-CN', nativeName: '简体中文', dir: 'ltr', matches: ['zh-cn', 'zh-hans', 'zh-sg'] },
  {
    code: 'zh-TW',
    nativeName: '繁體中文',
    dir: 'ltr',
    matches: ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']
  },
  { code: 'en', nativeName: 'English', dir: 'ltr', matches: ['en'] },
  { code: 'ja', nativeName: '日本語', dir: 'ltr', matches: ['ja'] },
  { code: 'ko', nativeName: '한국어', dir: 'ltr', matches: ['ko'] },
  { code: 'vi', nativeName: 'Tiếng Việt', dir: 'ltr', matches: ['vi'] },
  { code: 'th', nativeName: 'ไทย', dir: 'ltr', matches: ['th'] },
  { code: 'ms', nativeName: 'Bahasa Melayu', dir: 'ltr', matches: ['ms'] },
  { code: 'id', nativeName: 'Bahasa Indonesia', dir: 'ltr', matches: ['id', 'in'] },
  { code: 'es', nativeName: 'Español', dir: 'ltr', matches: ['es'] },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', dir: 'ltr', matches: ['pt'] },
  { code: 'ar', nativeName: 'العربية', dir: 'rtl', matches: ['ar'] }
]

export function isLocale(v: string): v is Locale {
  return v in dictionaries
}

export function localeDir(locale: Locale): Direction {
  return LOCALES.find((l) => l.code === locale)?.dir ?? 'ltr'
}

/**
 * 把系统语言标签解析成受支持的界面语言。
 *
 * 匹配顺序：完整标签 → 已登记的匹配前缀 → 主语言子标签 → 英语。
 * 中文必须先按 Hant/Hans 判，只看 "zh" 会把台港用户丢给简体。
 */
export function matchSystemLocale(systemLocale: string | undefined): Locale {
  const tag = (systemLocale ?? '').toLowerCase().replace(/_/g, '-')
  if (!tag) return 'en'
  if (isLocale(tag)) return tag

  for (const l of LOCALES) {
    if (l.matches.some((m) => tag === m || tag.startsWith(`${m}-`))) return l.code
  }
  const primary = tag.split('-')[0] ?? ''
  for (const l of LOCALES) {
    if (l.matches.includes(primary)) return l.code
  }
  return 'en'
}

/** 解析最终界面语言：设置为 'auto' 或非法值时按系统语言推断 */
export function resolveLocale(setting: string | undefined, systemLocale: string | undefined): Locale {
  if (setting && setting !== 'auto' && isLocale(setting)) return setting
  return matchSystemLocale(systemLocale)
}

interface I18n {
  locale: Locale
  dir: Direction
  t: (key: MessageKey) => string
}

const I18nContext = createContext<I18n>({ locale: 'zh-CN', dir: 'ltr', t: (k) => zhCN[k] })

export function I18nProvider({
  locale,
  children
}: {
  locale: Locale
  children: ReactNode
}): React.JSX.Element {
  const dict = dictionaries[locale] as Partial<Record<MessageKey, string>>
  const dir = localeDir(locale)
  // 未翻译的 key 回落英语而不是中文：英语的受众面更广
  const t = (key: MessageKey): string => dict[key] ?? en[key] ?? zhCN[key]
  return <I18nContext.Provider value={{ locale, dir, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
