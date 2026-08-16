import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * 白牌：构建时通过 BRAND=<name> 选择 branding/<name>.json，
 * 三端（client/admin/server）共用同一份配置。缺文件直接抛错 ——
 * 打错品牌名悄悄回落默认值，上线才发现叫错名字，代价更大。
 */
const brandName = process.env.BRAND || 'default'
const brand = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'branding', `${brandName}.json`), 'utf8')
)
const define = { __BRAND__: JSON.stringify(brand) }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
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
})
