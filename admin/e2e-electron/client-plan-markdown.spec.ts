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

// M11 套餐描述 Markdown 渲染：客户端套餐卡把管理员写的 Markdown 结构化渲染（加粗/列表）。
// plan-desc-edit 验后台设描述、subscribe 验展示套餐名，但 Markdown 结构渲染此前没测。
test('客户端套餐：描述以 Markdown 结构渲染（加粗+列表）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `旗舰套餐${TAG}`
  const desc = `**旗舰特权${TAG}**\n- 优先客服\n- 无限并发\n- 专属对接`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: planName, priceCents: 4900, periodUnit: 'month', periodCount: 1, maxAccounts: 50, maxDevices: 0, description: desc })
  })
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-planmd-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-billing').click()
  await win.locator('.page-tabs button', { hasText: '套餐' }).click()

  const card = win.locator('.plan-card', { hasText: planName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  // Markdown 结构渲染：加粗 <strong> + 列表 <li>×3（而非原始 ** 与 -）
  await expect(card.locator('.md strong')).toHaveText(`旗舰特权${TAG}`)
  await expect(card.locator('.md li')).toHaveCount(3)
  await expect(card.locator('.md li').nth(0)).toHaveText('优先客服')
  // 不出现原始 Markdown 记号
  await expect(card.locator('.md')).not.toContainText('**')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-114-plan-markdown.png` })
  await app.close()
})
