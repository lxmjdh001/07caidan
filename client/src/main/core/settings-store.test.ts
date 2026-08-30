import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('get 返回副本，外部修改不污染内部状态', () => {
    const s = store.get()
    s.locale = 'hacked'
    expect(store.get().locale).toBe('auto')
  })
})
