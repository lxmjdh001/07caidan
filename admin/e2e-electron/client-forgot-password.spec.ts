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

// 自助找回密码整段旅程（此前无 UI 覆盖）：登录页点「忘记密码」→ 发验证码 → 填码+新密码
// → 重置成功回登录页 → 用新密码登录成功。开发模式(未配 SMTP)验证码固定 12345，可端到端跑。
test('客户端找回密码：忘记密码→验证码重置→新密码登录', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  // 先注册（旧密码）
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'oldpass123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-forgot-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.auth-gate')).toBeVisible({ timeout: 20_000 })

  // 登录页 → 点「忘记密码」进入找回模式
  await win.getByRole('button', { name: '忘记密码' }).click()
  await expect(win.getByText('新密码（至少 8 位）')).toBeVisible({ timeout: 10_000 })

  // 填邮箱 + 新密码，发验证码（开发模式固定 12345）
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('newpass456')
  await win.getByRole('button', { name: '发送验证码' }).click()
  await expect(win.locator('.auth-info')).toContainText('验证码已发送', { timeout: 10_000 })
  await win.locator('.code-row input').fill('12345')

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-forgot-password.png` })

  // 提交重置 → 回登录页并提示已重置
  await win.locator('.auth-submit').click()
  await expect(win.getByText('密码已重置，请用新密码登录')).toBeVisible({ timeout: 10_000 })

  // 用新密码登录成功（进入主界面）
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('newpass456')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await app.close()
})
