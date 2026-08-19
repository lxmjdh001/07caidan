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

// M11 账单页「余额流水」：billing-history 只验了充值订单表，余额流水（调整/兑换等含
// 运行余额 balanceAfter 的明细）此前没测。用两笔余额调整造出带运行余额的流水。
test('客户端账单：余额流水显示调整明细与运行余额', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 两笔调整：+$20 → 余额 $20；-$5 → 余额 $15（产生两条含运行余额的流水）
  await fetch(`${API}/api/admin/balance-adjust`, { method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 2000, note: 'e2e-in' }) })
  await fetch(`${API}/api/admin/balance-adjust`, { method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: -500, note: 'e2e-out' }) })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-ledger-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.locator('.page-tabs button', { hasText: '账单' }).click()

  // 余额流水区：两条「调整」，运行余额分别 $20.00 与 $15.00
  const ledger = win.locator('section.form-card').filter({ hasText: '余额流水' })
  await expect(ledger).toBeVisible({ timeout: 10_000 })
  const rows = ledger.locator('table.data-table tbody tr')
  await expect(rows.filter({ hasText: '调整' })).toHaveCount(2, { timeout: 10_000 })
  await expect(ledger.getByText('$20.00').first()).toBeVisible()
  await expect(ledger.getByText('$15.00').first()).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-91-ledger.png` })
  await app.close()
})
