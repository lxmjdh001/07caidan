#!/usr/bin/env node
/**
 * 客户端 i18n 覆盖率检查（CI 用）。
 * 规范键集来自 zh-CN（定义 MessageKey）。指定的「完整」语言若跌破 100% 即非零退出，
 * 防止新增键漏译导致运行时回落英文。其余语言只报告覆盖率，不阻断。
 *
 * 用法：node scripts/i18n-coverage.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverage, extractKeys } from './i18n-coverage-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const localesDir = join(here, '..', 'client', 'src', 'renderer', 'src', 'locales')

/** 必须保持 100% 的语言（跌破即失败） */
const REQUIRED_COMPLETE = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'vi', 'id', 'ms']

const canonical = extractKeys(readFileSync(join(localesDir, 'zh-CN.ts'), 'utf8'))
const files = readdirSync(localesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort()

let failed = 0
console.log(`规范键数（zh-CN）：${canonical.size}\n`)
for (const name of files) {
  const keys = extractKeys(readFileSync(join(localesDir, `${name}.ts`), 'utf8'))
  const c = coverage(canonical, keys)
  const must = REQUIRED_COMPLETE.includes(name)
  const bad = must && c.pct < 100
  if (bad) failed++
  const tag = must ? (c.pct >= 100 ? '✓ 完整' : '✗ 应完整') : '·'
  console.log(`${bad ? '✗' : ' '} ${name.padEnd(7)} ${String(c.pct).padStart(5)}%  (${c.present}/${c.total})  ${tag}`)
}

console.log('')
if (failed > 0) {
  console.error(`i18n 覆盖率检查失败：${failed} 个应完整的语言未达 100%`)
  process.exit(1)
}
console.log('i18n 覆盖率检查通过：指定语言均 100%')
