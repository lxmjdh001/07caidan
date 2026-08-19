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

// M11 余额充足时在客户端点「订阅」→ 直接扣余额订阅成功：套餐卡转「当前套餐」+ 概览余额扣减
// 既有 billing-active 用 API 预置订阅只验展示，subscribe-nobalance 只验失败分支，
// 「余额足 → UI 点订阅 → 成功扣款」这条真实成交路径此前没有点击级覆盖。
test('客户端套餐：余额充足点订阅成功并扣减余额', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `余额套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // $30 套餐；老板给 $50 余额 → 订阅后应剩 $20
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 3000, periodUnit: 'month', periodCount: 1, maxAccounts: 20, maxDevices: 0 })
  })
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-subbal-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
  // 概览：初始余额 $50.00
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$50.00', { timeout: 10_000 })

  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  const card = win.locator('.plan-card', { hasText: planName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  // 订阅前按钮为「订阅」→ 点击
  await card.getByRole('button', { name: '订阅' }).click()
  // 订阅成功：卡片按钮转「当前套餐」并禁用（未走余额不足的直付面板）
  const currentBtn = card.getByRole('button', { name: '当前套餐' })
  await expect(currentBtn).toBeVisible({ timeout: 10_000 })
  await expect(currentBtn).toBeDisabled()

  // 回概览：当前套餐为该套餐，余额扣 $30 → $20.00
  await win.locator('.page-tabs button', { hasText: '概览' }).click()
  await expect(win.getByText('当前套餐')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText(planName)).toBeVisible()
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$20.00')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-81-subscribe-balance.png` })
  await app.close()
})
