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

// M11 套餐切换折算：已订阅基础套餐后当天改订专业套餐 → 服务端 changePlan 走 proration
// （旧套餐整期未用 → 全额折回 + 收新套餐 = 净额），当前套餐徽标从基础移到专业、余额按净额扣。
// subscribe-balance 只覆盖「首次订阅」，「已订阅→切换套餐并折算」这条真实升级路径此前没点测。
test('客户端套餐：已订阅后切换套餐走折算，徽标转移且余额扣净额', async () => {
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
  // 基础 $20/月、专业 $50/月；老板给 $100 余额
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
    body: JSON.stringify({ email, deltaCents: 10000, note: 'e2e' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-planswitch-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  // 概览：初始余额 $100.00
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$100.00', { timeout: 10_000 })

  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  const basicCard = win.locator('.plan-card', { hasText: basicName })
  const proCard = win.locator('.plan-card', { hasText: proName })
  await expect(basicCard).toBeVisible({ timeout: 10_000 })

  // 1) 先订基础 → 扣 $20，基础卡转「当前套餐」
  await basicCard.getByRole('button', { name: '订阅' }).click()
  await expect(basicCard.getByRole('button', { name: '当前套餐' })).toBeVisible({ timeout: 10_000 })
  await win.locator('.page-tabs button', { hasText: '概览' }).click()
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$80.00', { timeout: 10_000 })

  // 2) 当天切到专业 → 折算：整期未用退回 $20、收 $50、净额 $30 → 余额 $80-$30=$50
  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  await proCard.getByRole('button', { name: '订阅' }).click()
  // 徽标转移：专业变「当前套餐」，基础退回可点「订阅」
  await expect(proCard.getByRole('button', { name: '当前套餐' })).toBeVisible({ timeout: 10_000 })
  await expect(basicCard.getByRole('button', { name: '订阅' })).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-plan-switch-proration.png` })

  // 概览：当前套餐为专业，余额按净额扣到 $50.00
  await win.locator('.page-tabs button', { hasText: '概览' }).click()
  await expect(win.getByText(proName)).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')).toHaveText('$50.00')

  await app.close()
})
