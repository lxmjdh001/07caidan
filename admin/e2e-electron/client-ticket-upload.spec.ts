import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))
const API = 'http://127.0.0.1:8798'

// 支持工单贴图上传：渲染端→主进程→服务端 二进制字节完整性（uploadTicketImage）
// 与 fetchMedia(下行)对照：本方向(上行)二进制完整，故 voice/贴图上传不受那个 bug 影响
test('客户端工单贴图上传：字节经 IPC 完整送达服务端', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-diag-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 渲染端构造已知字节 0..255（256 字节），经 uploadTicketImage 送主进程→服务端
  const mediaId = await win.evaluate(async () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    // @ts-expect-error window.omni 由 preload 暴露
    return (await window.omni.billing('uploadTicketImage', bytes, 'application/octet-stream')) as string
  })
  expect(typeof mediaId).toBe('string')

  // 用同一租户令牌把上传的媒体取回，逐字节核对是否仍是 0..255。
  // 媒体按租户隔离，其他新注册用户理应拿到 404，不能用于完整性校验。
  const sameClient = await fetch(`${API}/api/client/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const back = await fetch(`${API}/api/media/${mediaId}`, { headers: { authorization: `Bearer ${sameClient.token}` } })
  expect(back.ok).toBe(true)
  const buf = new Uint8Array(await back.arrayBuffer())
  console.log('[DIAG] uploaded back length =', buf.length, '(expect 256)')
  expect(buf.length).toBe(256)
  let ok = true
  for (let i = 0; i < 256; i++) if (buf[i] !== i) { ok = false; break }
  console.log('[DIAG] bytes intact =', ok)
  expect(ok, '渲染端→主进程二进制应完整送达（若 false 则同 fetchMedia 类缺陷，voice/贴图上传均受影响）').toBe(true)

  await app.close()
})
