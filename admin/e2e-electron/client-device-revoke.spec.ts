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

// M5 设备管理：团队管理→登录设备列出多台设备，非本机可远程下线
test('客户端登录设备：列出设备并远程下线其它设备', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const otherDevice = `老板的手机${TAG}`

  // 注册老板并携带一台“手机”设备（客户端登录时会再上报本机设备）
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', deviceId: `phone-${TAG}`, deviceName: otherDevice })
  })
  expect(reg.ok).toBeTruthy()

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-devrev-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '团队管理' }).click()

  // 登录设备区：出现“老板的手机”与本机（>=2 行）
  const devSection = win.locator('section.form-card').filter({ hasText: '登录设备' })
  await expect(devSection.getByText(otherDevice)).toBeVisible({ timeout: 10_000 })
  await expect(devSection.getByText('本机')).toBeVisible()
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-52-devices.png` })

  // 远程下线“老板的手机”那台（非本机行的“下线”按钮）
  const otherRow = devSection.locator('tr', { hasText: otherDevice })
  await otherRow.getByRole('button', { name: '下线' }).click()
  await expect(devSection.getByText(otherDevice)).toHaveCount(0, { timeout: 10_000 })

  await app.close()
})
