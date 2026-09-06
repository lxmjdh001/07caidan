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

// M11 客户端充值只看得到「启用」通道（/api/billing/channels 传 onlyEnabled=true）：停用通道
// 不进付款卡列表。channel-disable-blocks-order 验了后台 API 拦截，这条「客户端不显示停用
// 通道」的 UX 侧此前没测。与 client-disabled-plan-hidden 一道，覆盖两个可购实体的两层防御。
test('客户端充值：停用的支付通道不出现在付款卡列表，启用的正常显示', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const onName = `在用通道${TAG}`
  const offName = `停用通道${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const mk = (name: string, enabled: boolean): Promise<unknown> =>
    fetch(`${API}/api/admin/channels`, {
      method: 'POST', headers: aAuth,
      body: JSON.stringify({ type: 'mock', name, currency: 'USD', enabled })
    })
  await mk(onName, true)
  await mk(offName, false)
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-chanhide-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.locator('.page-tabs button', { hasText: '充值' }).click()
  await win.locator('label.field', { hasText: '金额（美元）' }).locator('input').fill('10.00')

  // 在用通道可见、停用通道不出现在付款卡里
  await expect(win.locator('.channel-card', { hasText: onName })).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.channel-card', { hasText: offName })).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-disabled-channel-hidden.png` })
  await app.close()
})
