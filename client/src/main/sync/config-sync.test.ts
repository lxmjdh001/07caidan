import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import { applySyncable, pickSyncable } from './config-sync'

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return structuredClone({ ...DEFAULT_SETTINGS, ...over })
}

describe('pickSyncable —— 安全白名单', () => {
  it('绝不含 accounts / sync / 各引擎 apiKey / platform 密钥', () => {
    const s = settings()
    s.sync.token = 'SECRET-TOKEN'
    s.accounts = { 'whatsapp:main': { credentials: { session: 'SECRET' }, proxyUrl: 'socks5://x' } }
    s.translation.deepl.apiKey = 'DEEPL-KEY'
    s.translation.llm.apiKey = 'LLM-KEY'
    s.platform.telegramApiHash = 'TG-HASH'

    const blob = pickSyncable(s)
    const dumped = JSON.stringify(blob)
    expect(dumped).not.toContain('SECRET-TOKEN')
    expect(dumped).not.toContain('SECRET')
    expect(dumped).not.toContain('DEEPL-KEY')
    expect(dumped).not.toContain('LLM-KEY')
    expect(dumped).not.toContain('TG-HASH')
    // 只应有白名单顶层键
    expect(Object.keys(blob).sort()).toEqual(
      ['autoReply', 'locale', 'notifications', 'theme', 'translation'].sort()
    )
    expect(Object.keys(blob.translation).sort()).toEqual(
      ['confirmBeforeSend', 'displayLang', 'engine', 'inboundEnabled', 'outboundEnabled', 'targetLangDefault'].sort()
    )
    // notifications/autoReply 是整体展开（{...s.xxx}），不像 translation 逐字段挑。
    // 钉死其键集，一旦这两个配置类型日后新增字段（尤其密钥类，如推送 token / 每会话 apiKey），
    // 本断言会红 → 强制开发者显式决定是否可同步，而不是被 spread 悄悄上云。
    expect(Object.keys(blob.notifications).sort()).toEqual(
      ['enabled', 'showPreview', 'sound'].sort()
    )
    expect(Object.keys(blob.autoReply).sort()).toEqual(
      ['cooldownSec', 'enabled', 'handoffKeywords', 'systemPrompt'].sort()
    )
  })

  it('抽取偏好值正确', () => {
    const s = settings()
    s.locale = 'ja'
    s.theme = 'dark'
    s.translation.targetLangDefault = 'th'
    const blob = pickSyncable(s)
    expect(blob.locale).toBe('ja')
    expect(blob.theme).toBe('dark')
    expect(blob.translation.targetLangDefault).toBe('th')
  })
})

describe('applySyncable —— 合并回本地', () => {
  it('覆盖白名单字段，但保留本地 apiKey', () => {
    const local = settings()
    local.translation.deepl.apiKey = 'LOCAL-DEEPL'
    local.translation.engine = 'google-free'
    const patch = applySyncable(local, {
      locale: 'ko',
      theme: 'light',
      translation: { engine: 'deepl', targetLangDefault: 'vi' }
    })
    expect(patch.locale).toBe('ko')
    expect(patch.theme).toBe('light')
    expect(patch.translation?.engine).toBe('deepl')
    expect(patch.translation?.targetLangDefault).toBe('vi')
    // 本地 deepl.apiKey 必须保留（浅合并 current.translation）
    expect(patch.translation?.deepl.apiKey).toBe('LOCAL-DEEPL')
  })

  it('脏数据/错误类型一律忽略', () => {
    const local = settings()
    expect(applySyncable(local, null)).toEqual({})
    expect(applySyncable(local, 'nope')).toEqual({})
    const patch = applySyncable(local, { locale: 123, theme: 'neon', translation: 'x' })
    expect(patch.locale).toBeUndefined()
    expect(patch.theme).toBeUndefined()
    expect(patch.translation).toBeUndefined()
  })

  it('pick→apply 往返保持白名单值稳定', () => {
    const a = settings()
    a.locale = 'ar'
    a.theme = 'dark'
    a.autoReply.cooldownSec = 42
    const blob = pickSyncable(a)
    const patch = applySyncable(settings(), blob)
    expect(patch.locale).toBe('ar')
    expect(patch.theme).toBe('dark')
    expect(patch.autoReply?.cooldownSec).toBe(42)
  })
})
