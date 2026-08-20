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
