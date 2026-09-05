#!/usr/bin/env node
/**
 * 校验 branding/ 下所有品牌配置（CI 用）。
 * 任一品牌任一字段不合规即非零退出 —— 防止“漏读配置/还叫旧名字/客户端连不上后台”上线。
 *
 * 用法：node scripts/verify-brands.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBrand } from './brand-schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const brandingDir = join(here, '..', 'branding')

// macOS 外置盘会生成 AppleDouble（._*.json），它们不是品牌配置。
const files = readdirSync(brandingDir).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
if (files.length === 0) {
  console.error('branding/ 下没有任何 *.json 品牌配置')
  process.exit(1)
}

let failed = 0
for (const file of files.sort()) {
  const name = file.replace(/\.json$/, '')
  let obj
  try {
    obj = JSON.parse(readFileSync(join(brandingDir, file), 'utf8'))
  } catch (err) {
    console.log(`✗ ${name}: JSON 解析失败 —— ${String(err)}`)
    failed++
    continue
  }
  const errors = validateBrand(name, obj)
  if (errors.length === 0) {
    console.log(`✓ ${name}  (${obj.appName} · ${obj.shortName})`)
  } else {
    failed++
    for (const e of errors) console.log(`✗ ${e}`)
  }
}

console.log('')
if (failed > 0) {
  console.error(`品牌校验失败：${failed}/${files.length} 个品牌有问题`)
  process.exit(1)
}
console.log(`品牌校验通过：${files.length} 个品牌全部合规`)
