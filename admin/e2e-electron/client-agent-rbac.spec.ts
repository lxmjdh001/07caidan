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

// M21 RBAC 界面隐藏：客服(agent)登录后只见聊天，看不到引流工单/套餐/团队/加账号
test('客户端 RBAC：客服子账号登录后导航按权限隐藏', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const member = await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: `agent${TAG}`, password: 'agentpass123', role: 'agent' })
  }).then((r) => r.json() as Promise<{ member: { email: string } }>)
  expect(member.member?.email).toBeTruthy()

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-rbac-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 以客服子账号登录
  await win.locator('input[type="email"]').fill(member.member.email)
  await win.locator('input[type="password"]').fill('agentpass123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 基础能力可见：全部消息(聊天) + 帮助与反馈
  await expect(win.locator('.account-row', { hasText: '全部消息' })).toBeVisible()
  await expect(win.getByTestId('management-workorders')).toHaveCount(0)
  await expect(win.getByTestId('management-subaccounts')).toHaveCount(0)
  await win.getByTestId('client-nav-trigger').click()
  await expect(win.getByTestId('client-nav-support')).toBeVisible()
  // 管理入口与账单按权限隐藏。
  await expect(win.getByTestId('client-nav-management')).toHaveCount(0)
  await expect(win.getByTestId('client-nav-billing')).toHaveCount(0)
  // 加账号“+”按钮也隐藏（无 accounts:manage）
  await expect(win.getByTitle('添加 WhatsApp 账号')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-55-agent-rbac.png` })
  await app.close()
})
