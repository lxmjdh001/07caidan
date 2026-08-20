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

// M11 充值手续费 gross-up 含固定费：3% + 固定 $0.30，$10 → 应付 ceil((1000+30)/0.97)=1062=$10.62、
// 手续费 $0.62。既有 gross-up 用例均 feeFixedCents=0，含固定费的口径此前没测。
test('客户端充值：手续费含固定费的 gross-up 应付（3%+$0.30 → $10.62）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const chName = `固定费通道${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mock', name: chName, currency: 'USD', feeRate: 0.03, feeFixedCents: 30, feePaidBy: 'customer' })
  })
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-tgfix-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.locator('.page-tabs button', { hasText: '充值' }).click()

  await win.locator('label.field', { hasText: '金额（美元）' }).locator('input').fill('10.00')
  const card = win.locator('.channel-card', { hasText: chName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  // gross-up 含固定费：手续费 $0.62、应付 $10.62
  await expect(card.locator('.channel-payable')).toHaveText('应付 $10.62')
  await expect(card.locator('.channel-fee')).toHaveText('手续费 $0.62')

  await card.click()
  await expect(win.getByText(/手续费约 \$0\.62.*预计支付 \$10\.62/)).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-116-topup-grossup-fixed.png` })
  await app.close()
})
