import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // macOS 在非原生文件系统（例如外接盘）会生成 AppleDouble `._*` 文件。
    // 它们不是 TypeScript 源码，若文件名恰好带 `.test.ts`，Vitest 会尝试解析二进制内容。
    exclude: ['**/._*'],
    environment: 'node'
  },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
