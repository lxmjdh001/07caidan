import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import { applySyncable, pickSyncable, pickSyncableAccounts } from './config-sync'

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return structuredClone({ ...DEFAULT_SETTINGS, ...over })
}

describe('pickSyncable —— 安全白名单', () => {
  it('绝不含 accounts / sync / 各引擎 apiKey / platform 密钥', () => {
    const s = settings()
    s.sync.token = 'SECRET-TOKEN'
    s.accounts = { 'whatsapp:main': { credentials: { session: 'SECRET' }, proxyUrl: 'socks5://x' } }
    s.proxyAssets = {
      'proxy-secret': {
        id: 'proxy-secret',
        proxyUrl: 'socks5://proxy-user:PROXY-PASSWORD@proxy.example:1080',
        note: 'PRIVATE-PROXY-NOTE',
        createdAt: 1,
        updatedAt: 1
      }
    }
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
    expect(dumped).not.toContain('PROXY-PASSWORD')
    expect(dumped).not.toContain('PRIVATE-PROXY-NOTE')
    expect(dumped).not.toContain('proxyAssets')
    // 只应有白名单顶层键
    expect(Object.keys(blob).sort()).toEqual(
      ['autoReply', 'locale', 'notifications', 'platformOrder', 'quickReplies', 'theme', 'translation'].sort()
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
    s.quickReplies = [{ id: 'shipping', title: '物流', text: '正在为您查询', category: '售后' }]
    const blob = pickSyncable(s)
    expect(blob.locale).toBe('ja')
    expect(blob.theme).toBe('dark')
    expect(blob.translation.targetLangDefault).toBe('th')
    expect(blob.quickReplies).toEqual([{ id: 'shipping', title: '物流', text: '正在为您查询', category: '售后' }])
    expect(blob.platformOrder).toEqual([
      'whatsapp', 'telegram', 'telegram_bot', 'line', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
  })
})

describe('pickSyncableAccounts —— 跨设备账号目录安全白名单', () => {
  it('保留稳定账号 key/备注/语言，但绝不带代理、指纹、凭证或设备名', () => {
    const s = settings()
    s.accounts = {
      'whatsapp:wa123': {
        label: '销售号',
        defaultLang: 'en',
        proxyUrl: 'socks5://user:secret@proxy:1080',
        fingerprint: { id: 'FP-X', seed: 'SECRET-SEED', deviceName: 'Mac', createdAt: 1 },
        deviceLabel: 'private-device',
        credentials: { session: 'SECRET-SESSION' }
      }
    }
    const accounts = pickSyncableAccounts(s)
    expect(accounts).toEqual([{
      accountKey: 'whatsapp:wa123', channel: 'whatsapp', accountId: 'wa123',
      label: '销售号', defaultLang: 'en'
    }])
    const dumped = JSON.stringify(accounts)
    expect(dumped).not.toContain('proxy')
    expect(dumped).not.toContain('SECRET')
    expect(dumped).not.toContain('device')
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
      platformOrder: ['line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram'],
      translation: { engine: 'deepl', targetLangDefault: 'vi' },
      quickReplies: [{ id: 'hello', title: '问候', text: '您好', category: '售前' }]
    })
    expect(patch.locale).toBe('ko')
    expect(patch.theme).toBe('light')
    expect(patch.platformOrder).toEqual([
      'line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
    expect(patch.translation?.engine).toBe('deepl')
    expect(patch.translation?.targetLangDefault).toBe('vi')
    expect(patch.quickReplies).toEqual([{ id: 'hello', title: '问候', text: '您好', category: '售前' }])
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
    expect(applySyncable(local, {
      quickReplies: [
        null,
        { id: '', title: '空 ID', text: '忽略' },
        { id: 'blank', title: '空内容', text: '   ' },
        { id: 'valid', title: '', text: '  有效内容  ', category: '  售后  ' },
        { id: 'valid', title: '重复', text: '忽略重复项' }
      ]
    }).quickReplies).toEqual([{ id: 'valid', title: '有效内容', text: '有效内容', category: '售后' }])
  })

  it('pick→apply 往返保持白名单值稳定', () => {
    const a = settings()
    a.locale = 'ar'
    a.theme = 'dark'
    a.autoReply.cooldownSec = 42
    a.quickReplies = [{ id: 'one', title: '第一条', text: '内容一' }]
    a.platformOrder = ['line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram']
    const blob = pickSyncable(a)
    const patch = applySyncable(settings(), blob)
    expect(patch.locale).toBe('ar')
    expect(patch.theme).toBe('dark')
    expect(patch.autoReply?.cooldownSec).toBe(42)
    expect(patch.quickReplies).toEqual(a.quickReplies)
    expect(patch.platformOrder).toEqual([
      'line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
  })
})
