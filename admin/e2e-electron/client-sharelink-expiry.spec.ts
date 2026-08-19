import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))
const API = 'http://127.0.0.1:8798'

// M9 分享链接有效期：过期链接公开端点自动 404，客户端标“已过期”
test('客户端分享链接：过期链接自动失效', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const acc = `sa${TAG}`
  const name = `过期测试工单${TAG}`

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name, accountIds: [acc], accountLabels: { [acc]: '号A' }, startAt: Date.now() - 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  // 建一个已过期的链接（expiresAt 在过去）
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: '过期链接', expiresAt: Date.now() - 60_000 })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  const token = link.link.token
  expect(token).toBeTruthy()

  // 公开端点：已过期 → 404(reason=expired)
  const pub = await fetch(`${API}/public/campaign/${token}`)
  expect(pub.status).toBe(404)
  expect((await pub.json() as { error?: string }).error).toBe('expired')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-expiry-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 客户端工单里该链接标“已过期”
  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.locator('.campaign-row', { hasText: name }).click()
  await expect(win.locator('.link-state', { hasText: '已过期' })).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-64-sharelink-expiry.png` })
  await app.close()
})
