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

// M21 团队管理：老板在成员表把子账号角色从「客服」改为自建角色 → updateTeamMember 落库，
// 权限列随之变化。既有 team 用例覆盖建角色/建成员/停用，唯独没碰成员角色下拉这条改派交互。
test('客户端团队：修改成员角色（客服→自建角色）并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = `${Date.now().toString(36).slice(-5)}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const roleName = `组长${TAG}`
  const agent = `agent${TAG}`

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  // 自建角色（含 campaigns:manage）+ 一个 agent 子账号
  const role = await fetch(`${API}/api/team/roles`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: roleName, permissions: ['campaigns:manage'] })
  }).then((r) => r.json() as Promise<{ role: { id: string } }>)
  expect(role.role?.id).toBeTruthy()
  await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: agent, password: 'agentpass123', role: 'agent' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-tmrole-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  const row = win.locator('tr', { hasText: agent })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 初始：角色下拉为 agent，权限列显示「仅聊天」
  const roleSel = row.locator('.team-role-select')
  await expect(roleSel).toHaveValue('agent')
  await expect(row.locator('.team-perm-cell')).toHaveText('仅聊天')

  // 改派为自建角色（受控项，值随刷新回来）
  await roleSel.selectOption(role.role.id)
  await expect(roleSel).toHaveValue(role.role.id, { timeout: 10_000 })
  // 权限列随角色变为该角色的权限标签
  await expect(row.locator('.team-perm-cell')).toHaveText('引流工单与重粉库', { timeout: 10_000 })

  // 落库校验（该老板名下仅此一个子账号；member 的用户名存于 email 字段）
  const members = (await fetch(`${API}/api/team/members`, { headers: auth }).then((r) => r.json())) as { members?: Array<{ email: string; role: string }> }
  expect(members.members?.length).toBe(1)
  expect(members.members?.[0]?.role).toBe(role.role.id)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-85-team-member-role.png` })
  await app.close()
})
