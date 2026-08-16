import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AccountConfig, type AppSettings } from '@shared/settings'

/**
 * 应用设置存储（JSON 文件，原子写入）。
 */
export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)

  constructor(dir: string) {
    this.filePath = join(dir, 'settings.json')
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // 与默认值深合并，保证升级后新增字段有值
      this.settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed)
    } catch {
      // 首次运行：使用默认值
    }
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, patch)
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await rename(tmp, this.filePath)
    return this.get()
  }

  accountConfig(key: string): AccountConfig {
    return this.settings.accounts[key] ?? {}
  }
}

/** 递归合并：patch 的对象字段与 base 合并，标量/数组直接覆盖 */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return deepMerge(base as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppSettings
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const prev = out[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}
