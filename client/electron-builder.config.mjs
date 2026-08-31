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

/**
 * 更新源地址：发布时用 UPDATE_URL 指定（如 https://api.example.com/updates）。
 * publish 配置的作用是让 builder 产出 latest-mac.yml / latest.yml 等元数据，
 * 发布 = 把 release/<brand>/ 里的 yml + 安装包一起拷到后台 updates 目录。
 */
const updateUrl = process.env.UPDATE_URL || 'https://example.com/updates'

export default {
  publish: [{ provider: 'generic', url: updateUrl }],
  appId: `com.${brand.shortName || 'omnichat'}.desktop`,
  productName: brand.appName,
  // 各品牌独立输出目录，多品牌连续打包互不覆盖
  directories: { output: `release/${brandName}` },
  files: ['out/**', 'package.json'],
  // 外置磁盘上的 macOS 构建目录可能生成 AppleDouble（._*）元数据文件；
  // electron-builder 的完整性扫描会误把 ._app.asar 当成 ASAR 读取而失败。
  // 关闭该附加校验不影响应用代码签名或 ASAR 本身的打包。
  disableAsarIntegrity: true,
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
    ...(existsSync(join(iconDir, 'icon.png')) ? { icon: join(iconDir, 'icon.png') } : {}),
    category: 'Office'
  }
}
