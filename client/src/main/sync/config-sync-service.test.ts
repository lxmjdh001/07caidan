import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../core/settings-store'
import { ConfigSync } from './config-sync-service'

let dir: string
let settings: SettingsStore

async function enableSync(settingsSyncedAt: number, cloudSync = true): Promise<void> {
  await settings.update({
    sync: { ...settings.get().sync, cloudSync, token: 'tok', serverUrl: 'http://server', settingsSyncedAt }
  })
}

function mockFetch(remote: { blob: unknown; updatedAt: number } | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (remote instanceof Error) throw remote
    return { ok: true, json: async () => remote } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omni-cfgsync-'))
  settings = new SettingsStore(dir)
  await settings.init()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

// ConfigSync 服务此前没测（config-sync.test 只测 pick/apply 纯函数）。这里补 pull 编排 +
// 「后写为准」冲突解决（updatedAt 比较）——若错，跨设备会互相回灌覆盖或拉不到。
describe('ConfigSync.pull（跨设备漫游·后写为准）', () => {
  it('云端更新（updatedAt 更大）→ 合并到本地并推进水位', async () => {
    await enableSync(50)
    mockFetch({ blob: { theme: 'dark' }, updatedAt: 100 })
    await new ConfigSync(settings).pull()
    expect(settings.get().theme).toBe('dark')
    expect(settings.get().sync.settingsSyncedAt).toBe(100)
  })

  it('云端不比本地新（updatedAt ≤ 水位）→ 绝不覆盖本地（防旧值回灌）', async () => {
    await settings.update({ theme: 'light' })
    await enableSync(50)
    const f = mockFetch({ blob: { theme: 'dark' }, updatedAt: 30 }) // 30 ≤ 50
    await new ConfigSync(settings).pull()
    expect(settings.get().theme).toBe('light') // 本地保留，不被旧云端盖掉
    expect(settings.get().sync.settingsSyncedAt).toBe(50) // 水位不动
    expect(f).toHaveBeenCalled() // 确实拉了、只是没应用
  })

  it('cloudSync 关闭 → 根本不发请求', async () => {
    await enableSync(50, false)
    const f = mockFetch({ blob: { theme: 'dark' }, updatedAt: 100 })
    await new ConfigSync(settings).pull()
    expect(f).not.toHaveBeenCalled()
  })

  it('云端 updatedAt 非法(0) → 跳过、不推进水位', async () => {
    await enableSync(50)
    mockFetch({ blob: { theme: 'dark' }, updatedAt: 0 })
    await new ConfigSync(settings).pull()
    expect(settings.get().sync.settingsSyncedAt).toBe(50)
  })

  it('网络失败 → 吞异常不崩，本地不变', async () => {
    await settings.update({ theme: 'light' })
    await enableSync(50)
    mockFetch(new Error('network down'))
    await expect(new ConfigSync(settings).pull()).resolves.toBeUndefined()
    expect(settings.get().theme).toBe('light')
  })
})

describe('ConfigSync.push（上云·不带密钥）', () => {
  it('上传的是 pickSyncable 白名单（密钥绝不上云）并按服务端返回推进水位', async () => {
    // 本地埋一个翻译引擎密钥
    await settings.update({
      translation: { ...settings.get().translation, deepl: { ...settings.get().translation.deepl, apiKey: 'DEEPL-SECRET-KEY' } }
    })
    await enableSync(50)
    let sentBody: { blob?: unknown; updatedAt?: number } | undefined
    const fn = vi.fn(async (_url: string, opts: { body: string }) => {
      sentBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ updatedAt: 999 }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fn)

    await new ConfigSync(settings).push()
    expect(fn).toHaveBeenCalled()
    // 红线：上云 blob 绝不含任何引擎密钥
    expect(JSON.stringify(sentBody?.blob)).not.toContain('DEEPL-SECRET-KEY')
    // 水位推进到服务端返回的 updatedAt
    expect(settings.get().sync.settingsSyncedAt).toBe(999)
  })

  it('push 失败（!ok）→ 不推进水位、不崩', async () => {
    await enableSync(50)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response))
    await expect(new ConfigSync(settings).push()).resolves.toBeUndefined()
    expect(settings.get().sync.settingsSyncedAt).toBe(50)
  })

  it('cloudSync 关闭 → push 不发请求', async () => {
    await enableSync(50, false)
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ updatedAt: 1 }) }) as unknown as Response)
    vi.stubGlobal('fetch', f)
    await new ConfigSync(settings).push()
    expect(f).not.toHaveBeenCalled()
  })
})

describe('ConfigSync.pushDebounced（1.5s 防抖）', () => {
  function countingFetch() {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ updatedAt: 999 }) }) as unknown as Response)
    vi.stubGlobal('fetch', f)
    return f
  }

  it('1.5s 内多次改动只推一次（合并，省流量/避免抖动）', async () => {
    await enableSync(50)
    const f = countingFetch()
    vi.useFakeTimers()
    try {
      const cs = new ConfigSync(settings)
      cs.pushDebounced()
      cs.pushDebounced()
      cs.pushDebounced()
      expect(f).not.toHaveBeenCalled() // 还没到 1.5s，一次都没推
      await vi.advanceTimersByTimeAsync(1500)
      expect(f).toHaveBeenCalledTimes(1) // 三次合并成一次
    } finally {
      vi.useRealTimers()
    }
  })

  it('新改动重置计时（是 debounce 不是 throttle）', async () => {
    await enableSync(50)
    const f = countingFetch()
    vi.useFakeTimers()
    try {
      const cs = new ConfigSync(settings)
      cs.pushDebounced()
      await vi.advanceTimersByTimeAsync(1000) // 距上次 1s
      cs.pushDebounced() // 重置计时
      await vi.advanceTimersByTimeAsync(1000) // 距最后一次改动才 1s → 不该推
      expect(f).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500) // 满 1.5s
      expect(f).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
