import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'

/**
 * 白牌：构建时通过 BRAND=<name> 选择 branding/<name>.json，
 * 三端（client/admin/server）共用同一份配置。缺文件直接抛错 ——
 * 打错品牌名悄悄回落默认值，上线才发现叫错名字，代价更大。
 */
const brandName = process.env.BRAND || 'default'
const brand = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'branding', `${brandName}.json`), 'utf8')
)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  // 本地 `npm run dev` 采用 development mode，但应与正式安装包使用同一对
  // Telegram 应用凭证；否则开发进程重启后会错误提示已登录账号重新填写 ID/Hash。
  // 生产专用文件仍被 git 忽略，且显式环境变量、当前 mode 的 .env 文件优先。
  const productionEnv = mode === 'production' ? env : loadEnv('production', __dirname, '')
  const telegramEnv = (key: 'OMNI_TG_API_ID' | 'OMNI_TG_API_HASH'): string =>
    (process.env[key] || env[key] || productionEnv[key] || '').trim()
  const define = { __BRAND__: JSON.stringify(brand) }

  /**
   * Telegram 的 api_id/api_hash 是“发布应用”的凭证，而不是终端客户的账号凭证。
   * Electron 打包后的主进程不会继承构建机环境变量，因此必须在 Vite 编译阶段替换为
   * 字面量；否则源码看似支持 OMNI_TG_API_*，安装到客户电脑后实际仍会读到空值。
   *
   * 只注入 main bundle，避免无意义地把它复制到 preload / renderer。发布机可把值保存在
   * 已被 git 忽略的 client/.env.production.local，避免后续版本漏传环境变量。
   */
  const mainDefine = {
    ...define,
    __OMNI_TG_API_ID__: JSON.stringify(telegramEnv('OMNI_TG_API_ID')),
    __OMNI_TG_API_HASH__: JSON.stringify(telegramEnv('OMNI_TG_API_HASH'))
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: mainDefine,
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      define,
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      }
    },
    renderer: {
      plugins: [react()],
      define,
      resolve: {
        alias: {
          '@shared': resolve('src/shared'),
          '@renderer': resolve('src/renderer/src')
        }
      }
    }
  }
})
