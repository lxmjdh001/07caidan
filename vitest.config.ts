import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
