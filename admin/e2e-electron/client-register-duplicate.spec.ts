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

// 注册错误路径的 UI 侧：用已注册邮箱在客户端注册 → 服务端回「该邮箱已注册」→ AuthGate 显示
// 该错误且停留在登录页。client-login-fail 覆盖了登录错误，注册重复邮箱的 UI 提示此前没测。
// 与 client-register-http（HTTP 层校验）成对：接口拒 + 界面如实提示。
test('客户端注册：重复邮箱给出「该邮箱已注册」提示且不进入主界面', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  // 先占用该邮箱
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-regdup-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.auth-gate')).toBeVisible({ timeout: 20_000 })

  // 切到注册模式 → 用已占用邮箱注册
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('anotherpw9')
  await win.locator('.auth-submit').click()

  // 显示「该邮箱已注册」，且仍停在登录/注册页（未进主界面）
  await expect(win.locator('.auth-err')).toContainText('该邮箱已注册', { timeout: 10_000 })
  await expect(win.getByTestId('client-nav-trigger')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-register-duplicate.png` })
  await app.close()
})
