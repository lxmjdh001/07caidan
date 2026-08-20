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

// M21 一致性护栏：仍有子账号在用的自定义角色不能删（删了会悄悄清空他们的权限）。
// team-role 覆盖建角色，删除在用角色被拒此前没测。
test('客户端团队：删除在用自定义角色被拒并提示', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const roleName = `在用角色${TAG}`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const role = await fetch(`${API}/api/team/roles`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: roleName, permissions: ['campaigns:manage'] })
  }).then((r) => r.json() as Promise<{ role: { id: string } }>)
  // 建一个用该角色的子账号 → 角色被占用
  await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: auth, body: JSON.stringify({ username: `agent${TAG}`, password: 'agentpass123', role: role.role.id })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-roledel-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '团队管理' }).click()
  const roleSection = win.locator('section.form-card').filter({ hasText: '自定义角色' })
  const roleRow = roleSection.locator('.team-member-row', { hasText: roleName })
  await expect(roleRow).toBeVisible({ timeout: 10_000 })

  // 点删除 → 被拒，提示「仍有子账号使用该角色」，角色仍在
  await roleRow.getByRole('button', { name: '删除' }).click()
  await expect(win.locator('.auth-err', { hasText: '仍有子账号使用该角色' })).toBeVisible({ timeout: 10_000 })
  await expect(roleSection.locator('.team-member-row', { hasText: roleName })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-115-role-delete-inuse.png` })
  await app.close()
})
