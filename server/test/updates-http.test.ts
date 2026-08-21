import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

// /updates/:file 是**公开无鉴权**的自动更新分发口，直接 join(updatesDir, 文件名) 读盘。
// 若文件名校验被削弱，就是路径穿越/任意文件读取(LFI)。整条路由此前零测试覆盖。
describe('自动更新分发 /updates/:file', () => {
  let dir: string
  let app: FastifyInstance

  function makeConfig(dbPath: string): ServerConfig {
    return {
      port: 0,
      host: '127.0.0.1',
      dbPath,
      mediaDir: join(dir, 'media'),
      tokens: ['dev-token'],
      anthropicApiKey: undefined,
      analysisModel: 'claude-opus-5',
      adminUser: 'admin',
      adminPassword: 'admin',
      adminTenant: 'dev-token',
      requireEmailVerify: false,
      clientTenant: 'dev-token',
      smtp: undefined,
      publicUrl: 'http://localhost:8787',
      updatesDir: join(dir, 'updates'),
      crispWebsiteId: undefined
    }
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-upd-'))
  })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
    await app.ready()
    // buildServer 会 mkdir updatesDir；往里放合法更新文件，往它外面放个「机密」文件
    writeFileSync(join(dir, 'updates', 'latest.yml'), 'version: 1.2.3\npath: App.dmg\n', 'utf8')
    writeFileSync(join(dir, 'updates', 'App-1.2.3.dmg'), Buffer.from([0x4d, 0x5a, 0x00, 0x01]))
    writeFileSync(join(dir, 'secret.txt'), 'TOPSECRET-PRIVATE-KEY', 'utf8') // 在 updatesDir 之外
  })

  test('合法 yml：200 + text/yaml + 内容正确', async () => {
    const r = await app.inject({ url: '/updates/latest.yml' })
    assert.equal(r.statusCode, 200)
    assert.match(String(r.headers['content-type']), /yaml/)
    assert.match(r.body, /version: 1\.2\.3/)
  })

  test('合法安装包：200 + octet-stream + 字节完整', async () => {
    const r = await app.inject({ url: '/updates/App-1.2.3.dmg' })
    assert.equal(r.statusCode, 200)
    assert.match(String(r.headers['content-type']), /octet-stream/)
    assert.equal(r.rawPayload.length, 4)
    assert.equal(r.headers['content-length'], '4')
  })

  test('不存在的合法文件名 → 404', async () => {
    const r = await app.inject({ url: '/updates/nope-9.9.9.dmg' })
    assert.equal(r.statusCode, 404)
  })

  // ── 路径穿越/LFI：任何越出 updatesDir 的尝试都必须挡下，且绝不泄露 updatesDir 外的机密 ──
  test('路径穿越 ../secret.txt → 挡下，绝不返回机密内容', async () => {
    for (const evil of [
      '/updates/..%2Fsecret.txt', // 编码斜杠
      '/updates/..%2f..%2fsecret.txt',
      '/updates/%2e%2e%2fsecret.txt' // 编码点
    ]) {
      const r = await app.inject({ url: evil })
      assert.ok(r.statusCode >= 400, `${evil} 竟返回 ${r.statusCode}`)
      assert.equal(r.body.includes('TOPSECRET'), false, `${evil} 泄露了机密文件`)
    }
  })

  test('隐藏文件/非法首字符（.env、点开头）→ 400', async () => {
    writeFileSync(join(dir, 'updates', '.env'), 'API_KEY=leak', 'utf8')
    const r = await app.inject({ url: '/updates/.env' })
    assert.equal(r.statusCode, 400)
    assert.equal(r.body.includes('leak'), false)
  })

  test('含 .. 的文件名一律拒（即便不含斜杠）→ 400', async () => {
    const r = await app.inject({ url: '/updates/foo..bar.yml' })
    assert.equal(r.statusCode, 400)
  })
})
