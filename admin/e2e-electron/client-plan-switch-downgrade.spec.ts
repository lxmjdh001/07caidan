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

// M11 套餐降级折算（净额为负 → 退款入余额）：已订专业后当天改订基础，服务端 changePlan
// 走 net<0 分支（跳过余额预检、写 proration_refund），余额应「增加」。plan-switch-proration
// 覆盖升级（净额为正、余额减），降级这条「余额反而变多」的分支此前无 UI 覆盖。
test('客户端套餐：降级切换净额为负，退款入账余额增加', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const basicName = `基础套餐${TAG}`
  const proName = `专业套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 基础 $20/月、专业 $50/月；老板给 $60 余额
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: basicName, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts: 10, maxDevices: 0 })
  })
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: proName, priceCents: 5000, periodUnit: 'month', periodCount: 1, maxAccounts: 50, maxDevices: 0 })
  })
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ email, deltaCents: 6000, note: 'e2e' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-planswdown-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$60.00', { timeout: 10_000 })

  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  const basicCard = win.locator('.plan-card', { hasText: basicName })
  const proCard = win.locator('.plan-card', { hasText: proName })
  await expect(proCard).toBeVisible({ timeout: 10_000 })

  // 1) 先订专业 $50 → 余额 $10
  await proCard.getByRole('button', { name: '订阅' }).click()
  await expect(proCard.getByRole('button', { name: '当前套餐' })).toBeVisible({ timeout: 10_000 })
  await win.locator('.page-tabs button', { hasText: '概览' }).click()
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$10.00', { timeout: 10_000 })

  // 2) 当天降级到基础 → 净额为负：整期未用退回 $50、收 $20，净退 $30 → 余额 $10+$30=$40（变多）
  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  await basicCard.getByRole('button', { name: '订阅' }).click()
  await expect(basicCard.getByRole('button', { name: '当前套餐' })).toBeVisible({ timeout: 10_000 })
  await expect(proCard.getByRole('button', { name: '订阅' })).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-plan-switch-downgrade.png` })

  // 概览：当前套餐为基础，余额从 $10 增加到 $40（退款入账，非扣款）
  await win.locator('.page-tabs button', { hasText: '概览' }).click()
  await expect(win.getByText(basicName)).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$40.00')

  await app.close()
})
