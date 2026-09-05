import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings-store'

let dir: string
let store: SettingsStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-settings-'))
  store = new SettingsStore(dir)
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore init 容错', () => {
  async function loadWith(content: string): Promise<{ dir: string; store: SettingsStore }> {
    const d = await mkdtemp(join(tmpdir(), 'omnichat-settings-fault-'))
    await writeFile(join(d, 'settings.json'), content, 'utf8')
    const s = new SettingsStore(d)
    await s.init() // 不得抛
    return { dir: d, store: s }
  }

  it('损坏的 settings.json → 回落默认、不崩', async () => {
    const { dir, store: s } = await loadWith('{ 这不是合法 JSON')
    expect(s.get().locale).toBe('auto')
    expect(s.get().translation.engine).toBe('google-free')
    await rm(dir, { recursive: true, force: true })
  })

  it('只含部分字段 → 存的保留、缺的深合并默认', async () => {
    const { dir, store: s } = await loadWith(JSON.stringify({ locale: 'ja' }))
    expect(s.get().locale).toBe('ja') // 存的字段保留
    expect(s.get().translation.engine).toBe('google-free') // 缺的补默认
    expect(s.get().accounts).toEqual({})
    await rm(dir, { recursive: true, force: true })
  })

  it('旧版平台顺序保持原排列并补上 KakaoTalk', async () => {
    const { dir, store: s } = await loadWith(JSON.stringify({
      platformOrder: ['line', 'whatsapp', 'telegram', 'telegram_bot']
    }))
    expect(s.get().platformOrder).toEqual([
      'line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
    await rm(dir, { recursive: true, force: true })
  })

  it('旧版账号代理自动迁移为独立代理资产并保留关联', async () => {
    const { dir, store: s } = await loadWith(JSON.stringify({
      accounts: {
        'line:main': {
          proxyUrl: 'socks5://user:pass@127.0.0.1:1080',
          proxyNote: '旧代理',
          proxyCreatedAt: 123
        }
      }
    }))
    const migrated = s.get()
    const id = migrated.accounts['line:main']?.proxyId
    expect(id).toMatch(/^legacy-/)
    expect(migrated.proxyAssets[id!]).toMatchObject({
      id,
      proxyUrl: 'socks5://user:pass@127.0.0.1:1080',
      note: '旧代理',
      createdAt: 123
    })

    const reloaded = new SettingsStore(dir)
    await reloaded.init()
    expect(reloaded.get().accounts['line:main']?.proxyId).toBe(id)
    expect(Object.keys(reloaded.get().proxyAssets)).toEqual([id])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('SettingsStore', () => {
  it('首次运行返回默认值：免费引擎 + 入站翻译开启', () => {
    const s = store.get()
    // 默认跟随系统语言，而不是写死中文
    expect(s.locale).toBe('auto')
    expect(s.translation.engine).toBe('google-free')
    expect(s.translation.inboundEnabled).toBe(true)
    expect(s.translation.confirmBeforeSend).toBe(false)
  })

  it('部分更新做深合并且持久化', async () => {
    await store.update({ translation: { ...store.get().translation, engine: 'custom-http' } })
    await store.update({ locale: 'en' })

    const reloaded = new SettingsStore(dir)
    await reloaded.init()
    expect(reloaded.get().locale).toBe('en')
    expect(reloaded.get().translation.engine).toBe('custom-http')
    // 未触碰的字段保留默认
    expect(reloaded.get().translation.displayLang).toBe('zh-CN')
  })

  it('账号级配置读写（代理）', async () => {
    expect(store.accountConfig('whatsapp:main')).toEqual({})
    await store.update({ accounts: { 'whatsapp:main': { proxyUrl: 'socks5://127.0.0.1:1080' } } })
    expect(store.accountConfig('whatsapp:main').proxyUrl).toBe('socks5://127.0.0.1:1080')
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'settings.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('整体替换账号凭证，登录成功后不残留一次性密码', async () => {
    await store.update({
      accounts: {
        'kakaotalk:main': {
          proxyUrl: 'socks5://127.0.0.1:1080',
          credentials: { email: 'owner@example.com', password: 'one-time-password' }
        }
      }
    })

    await store.replaceAccountCredentials('kakaotalk:main', {
      email: 'owner@example.com',
      accessToken: 'session-token'
    })

    expect(store.accountConfig('kakaotalk:main')).toEqual({
      proxyUrl: 'socks5://127.0.0.1:1080',
      credentials: { email: 'owner@example.com', accessToken: 'session-token' }
    })

    await store.replaceAccountCredentials('kakaotalk:main', {})
    expect(store.accountConfig('kakaotalk:main').credentials).toEqual({})
  })

  it('账号注册表默认为空；包括原主账号在内的账号均可删除并持久化', async () => {
    expect(store.get().accounts).toEqual({})
    await store.update({ accounts: { 'whatsapp:main': { defaultLang: 'ja' } } })
    expect(Object.keys(store.get().accounts)).toEqual(['whatsapp:main'])

    await store.removeAccount('whatsapp:main')
    expect(store.get().accounts['whatsapp:main']).toBeUndefined()

    const reloaded = new SettingsStore(dir)
    await reloaded.init()
    expect(reloaded.get().accounts['whatsapp:main']).toBeUndefined()
    expect(reloaded.get().accounts).toEqual({})
  })

  it('原子替换网络配置可真正解除账号关联并删除代理资产', async () => {
    await store.update({
      proxyAssets: {
        p1: { id: 'p1', proxyUrl: 'socks5://127.0.0.1:1080', createdAt: 1, updatedAt: 1 }
      },
      accounts: {
        'whatsapp:main': { proxyId: 'p1', proxyUrl: 'socks5://127.0.0.1:1080' }
      }
    })
    await store.replaceNetworkConfig({ 'whatsapp:main': {} }, {})
    expect(store.get().accounts['whatsapp:main']).toEqual({})
    expect(store.get().proxyAssets).toEqual({})
  })

  it('get 返回副本，外部修改不污染内部状态', () => {
    const s = store.get()
    s.locale = 'hacked'
    expect(store.get().locale).toBe('auto')
  })

  it('并发更新串行写盘，最后状态完整持久化', async () => {
    await expect(Promise.all([
      store.update({ locale: 'en' }),
      store.update({ theme: 'dark' }),
      store.update({ notifications: { ...store.get().notifications, sound: false } })
    ])).resolves.toHaveLength(3)

    const reloaded = new SettingsStore(dir)
    await reloaded.init()
    expect(reloaded.get()).toMatchObject({
      locale: 'en',
      theme: 'dark',
      notifications: { sound: false }
    })
  })
})
