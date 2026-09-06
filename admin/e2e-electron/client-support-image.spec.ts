import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const REPO = resolve(CLIENT_DIR, '..')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))
const API = 'http://127.0.0.1:8798'

// M18 支持工单贴图：鉴权媒体通道（红线：受保护图片仅带令牌可下载，字节完整）
// + 客户端经 fetchMedia(base64 data URL)渲染客服回复的图片（曾因 IPC 传二进制损坏
// 而 EncodingError 空白，改传 data URL 字符串后修复，本用例回归钉死）。
test('M18 支持工单贴图：鉴权下载通道 + 客户端渲染客服回复图片', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-supimg-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const TAG = Date.now().toString(36).slice(-5)
  const title = `贴图工单${TAG}`
  const mediaId = `sup-img-${TAG}.png`
  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 客户端提交工单
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-support').click()
  await win.getByRole('button', { name: '提交问题' }).first().click()
  await win.locator('.form-page input[type="text"]').first().fill(title)
  await win.locator('textarea').first().fill('界面显示异常，见客服稍后发的图。')
  await win.getByRole('button', { name: '提交', exact: true }).click()
  await expect(win.getByText(title).first()).toBeVisible({ timeout: 10_000 })

  // 使用工单所属租户的 sync 令牌上传图片（PUT /api/media 需 requireSync）。
  // 媒体严格按租户隔离，不能拿另一个临时客户的令牌上传后再跨租户引用。
  const sameClient = await fetch(`${API}/api/client/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const iconBytes = readFileSync(join(REPO, 'branding', 'default', 'icon.png'))
  const up = await fetch(`${API}/api/media/${mediaId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${sameClient.token}`, 'content-type': 'image/png' },
    body: iconBytes
  })
  expect(up.ok).toBeTruthy()

  // 红线1：带令牌下载 → 200 + image/png + 字节完整
  const ok = await fetch(`${API}/api/media/${mediaId}`, { headers: { authorization: `Bearer ${sameClient.token}` } })
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toContain('image/png')
  expect((await ok.arrayBuffer()).byteLength).toBe(iconBytes.byteLength)

  // 红线2：无令牌 → 拿不到（tenant 无法解析 → 非 200）
  const noAuth = await fetch(`${API}/api/media/${mediaId}`)
  expect(noAuth.status).not.toBe(200)

  // 管理员带图回复该工单
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const list = await fetch(`${API}/api/admin/support/tickets`, { headers: aAuth })
    .then((r) => r.json() as Promise<{ tickets: Array<{ id: string; title: string }> }>)
  const ticket = list.tickets.find((t) => t.title === title)
  expect(ticket).toBeTruthy()
  const rep = await fetch(`${API}/api/support/tickets/${ticket!.id}/messages`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ body: '这是问题截图', mediaId })
  })
  expect(rep.ok).toBeTruthy()

  // 客户端打开工单 → 客服带图回复渲染：文本 + 图片真解码出像素
  await win.locator('.ticket-item, li, button', { hasText: title }).first().click()
  await expect(win.locator('.sup-msg.theirs').filter({ hasText: '这是问题截图' })).toBeVisible({ timeout: 10_000 })
  const img = win.locator('.ticket-img')
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 10_000 })
  await expect(async () => {
    const nw = await img.evaluate((el: HTMLImageElement) => el.naturalWidth)
    expect(nw).toBeGreaterThan(0)
  }).toPass({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-47-support-image.png` })
  await app.close()
})
