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

// M11 边界：余额不足时点订阅 → 不报错，转入套餐直付面板选通道付款
test('客户端套餐：余额不足订阅转入直付面板', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `直付套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 建一个较贵的套餐 + mock 通道（老板无余额，必然余额不足）
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 9900, periodUnit: 'month', periodCount: 1, maxAccounts: 50, maxDevices: 0 })
  })
  await fetch(`${API}/api/admin/channels`, { method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'mock', name: `通道${TAG}`, currency: 'USD' }) })
  // 注册老板（零余额）
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-nobal-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 找到该套餐卡片，点订阅（余额 0，必余额不足）
  const card = win.locator('.plan-card', { hasText: planName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.getByRole('button', { name: '订阅' }).click()

  // 转入直付面板：出现「购买套餐：<套餐名>」+ 返回套餐
  await expect(win.getByText(new RegExp(`购买套餐：.*${planName}`))).toBeVisible({ timeout: 10_000 })
  await expect(win.getByRole('button', { name: '返回套餐' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-60-subscribe-nobalance.png` })
  await app.close()
})
