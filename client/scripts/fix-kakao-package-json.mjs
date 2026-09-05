import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// @lukim9-kakao 5.0.0-alpha.2 的 npm 包 package.json 带 UTF-8 BOM。
// Node 能加载模块，但 Vite/Vitest 的 JSON 解析器会报错；安装后只去掉 BOM，不改依赖源码。
const packages = [
  'client-android',
  'protocol-android',
  'protocol-core',
  'protocol-profiles',
  'transport-node'
]

for (const name of packages) {
  const file = resolve('node_modules', '@lukim9-kakao', name, 'package.json')
  try {
    const source = await readFile(file, 'utf8')
    if (source.charCodeAt(0) === 0xfeff) await writeFile(file, source.slice(1), 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
    throw error
  }
}
