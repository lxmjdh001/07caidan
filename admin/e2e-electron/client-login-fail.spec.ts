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

// 登录错误路径：密码错误时给出错误提示且停留在登录页（不进入主界面）
test('客户端登录：密码错误给出提示且不进入主界面', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  // 先注册一个真实账号，再用错误密码登录
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-loginfail-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 默认登录态：填对邮箱 + 错误密码
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('wrong-password-999')
  await win.locator('.auth-submit').click()

  // 出现错误提示，且不进入主界面（无 rail-nav）
  await expect(win.locator('.auth-err')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByTestId('client-nav-trigger')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-59-login-fail.png` })

  // 用正确密码则能进入（对照，确认账号本身有效）
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await app.close()
})
