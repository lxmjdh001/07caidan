import { mkdtemp, rm } from 'node:fs/promises'
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

describe('SettingsStore', () => {
  it('首次运行返回默认值：免费引擎 + 入站翻译开启', () => {
    const s = store.get()
    expect(s.locale).toBe('zh-CN')
    expect(s.translation.engine).toBe('google-free')
    expect(s.translation.inboundEnabled).toBe(true)
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

  it('get 返回副本，外部修改不污染内部状态', () => {
    const s = store.get()
    s.locale = 'hacked'
    expect(store.get().locale).toBe('zh-CN')
  })
})
