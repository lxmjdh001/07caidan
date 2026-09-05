import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 品牌信息（白牌）。服务端在**运行时**读取 branding/<BRAND>.json ——
 * 与前端的构建期注入不同，改品牌只需重启，不用重新构建。
 * 缺文件直接抛错：打错品牌名悄悄回落默认值，上线才发现叫错名字。
 */
export interface Brand {
  appName: string
  logoText: string
  company: string
  supportEmail: string
  dashboardTitle: string
}

const FALLBACK: Brand = {
  appName: 'WzzScrm',
  logoText: 'W',
  company: 'WzzScrm',
  supportEmail: '',
  dashboardTitle: 'WzzScrm 引流看板'
}

export function loadBrand(): Brand {
  const name = process.env.BRAND || 'default'
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', '..', 'branding', `${name}.json`)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Brand>
    return { ...FALLBACK, ...parsed }
  } catch (err) {
    if (process.env.BRAND) {
      // 显式指定了品牌但读不到 → 硬失败
      throw new Error(`品牌配置读取失败: ${path}: ${String(err)}`)
    }
    return FALLBACK
  }
}

export const brand = loadBrand()
