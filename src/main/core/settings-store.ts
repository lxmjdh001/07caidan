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
      this.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...parsed,
        translation: {
          ...structuredClone(DEFAULT_SETTINGS.translation),
          ...parsed.translation,
          custom: {
            ...DEFAULT_SETTINGS.translation.custom,
            ...parsed.translation?.custom
          }
        },
        accounts: parsed.accounts ?? {}
      }
    } catch {
      // 首次运行：使用默认值
    }
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = {
      ...this.settings,
      ...patch,
      translation: { ...this.settings.translation, ...patch.translation },
      accounts: { ...this.settings.accounts, ...patch.accounts }
    }
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await rename(tmp, this.filePath)
    return this.get()
  }

  accountConfig(key: string): AccountConfig {
    return this.settings.accounts[key] ?? {}
  }
}
