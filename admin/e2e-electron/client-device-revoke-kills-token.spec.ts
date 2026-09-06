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

async function meStatus(token: string): Promise<number> {
  return (await fetch(`${API}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } })).status
}

// 红线（会话安全）：远程下线一台设备必须让该设备的令牌立即失效（丢手机可远程登出）。
// device-revoke 只验设备从列表消失；令牌是否真被杀此前没测。若不杀，下线只是障眼法。
test('客户端设备下线：被下线设备的令牌立即失效', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const otherDevice = `老板的手机${TAG}`
  // 注册即建“手机”设备会话，拿到该设备令牌
  const reg = (await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', deviceId: `phone-${TAG}`, deviceName: otherDevice })
  }).then((r) => r.json())) as { token: string }
  expect(reg.token).toBeTruthy()
  // 下线前：手机令牌可用
  expect(await meStatus(reg.token)).toBe(200)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-devkill-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-subaccounts').click()
  const devSection = win.locator('section.form-card').filter({ hasText: '登录设备' })
  const otherRow = devSection.locator('tr', { hasText: otherDevice })
  await expect(otherRow).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-102-device-revoke-kills-token.png` })

  // 远程下线手机
  await otherRow.getByRole('button', { name: '下线' }).click()
  await expect(devSection.getByText(otherDevice)).toHaveCount(0, { timeout: 10_000 })

  // 红线：手机令牌立即失效（不再 200）
  await expect.poll(() => meStatus(reg.token), { timeout: 10_000 }).not.toBe(200)

  await app.close()
})
