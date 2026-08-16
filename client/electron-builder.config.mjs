import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * electron-builder 配置（白牌感知）。
 *
 * BRAND=<name> 与 electron-vite 构建时保持一致 —— 两步必须用同一个品牌，
 * 否则安装包名是 A、界面里显示的是 B。dist 脚本把两步串在一起避免手滑。
 */
const here = dirname(fileURLToPath(import.meta.url))
const brandName = process.env.BRAND || 'default'
const brand = JSON.parse(
  readFileSync(join(here, '..', 'branding', `${brandName}.json`), 'utf8')
)

/** 品牌图标目录（branding/<brand>/icon.icns|ico）；缺失时用 Electron 默认图标并在构建日志提示 */
const iconDir = join(here, '..', 'branding', brandName)
const macIcon = join(iconDir, 'icon.icns')
const winIcon = join(iconDir, 'icon.ico')

export default {
  appId: `com.${brand.shortName || 'omnichat'}.desktop`,
  productName: brand.appName,
  // 各品牌独立输出目录，多品牌连续打包互不覆盖
  directories: { output: `release/${brandName}` },
  files: ['out/**', 'package.json'],
  // npm 包名保持 omnichat；安装产物的内部名跟品牌走
  extraMetadata: { name: brand.shortName || 'omnichat' },
  asar: true,
  mac: {
    category: 'public.app-category.business',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    ...(existsSync(macIcon) ? { icon: macIcon } : {})
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    ...(existsSync(winIcon) ? { icon: winIcon } : {})
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // 安装/卸载条目显示品牌名
    shortcutName: brand.appName
  },
  linux: {
    target: ['AppImage'],
    category: 'Office'
  }
}
