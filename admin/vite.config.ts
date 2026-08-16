import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 白牌：BRAND=<name> 读取仓库根 branding/<name>.json；缺文件直接抛错
const brandName = process.env.BRAND || 'default'
const brand = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'branding', `${brandName}.json`), 'utf8')
)

export default defineConfig({
  plugins: [react()],
  define: { __BRAND__: JSON.stringify(brand) },
  server: { port: 5180 }
})
