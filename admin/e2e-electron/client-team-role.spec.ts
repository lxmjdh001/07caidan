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

// M21 客户端 RBAC：老板建自定义角色，勾选权限子集（委派 ⊆ 己权），保存后在角色列表核对
test('客户端团队：老板建自定义角色并勾选权限子集，列表核对', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-role-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 有启用的全员公告时会弹通知框，其 backdrop 会拦截后续点击，先关掉
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '团队管理' }).click()
  const roleName = `组长${Date.now().toString(36).slice(-4)}`

  // 打开「创建角色」弹窗（此时页面上只有区块按钮这一个同名按钮）
  await win.getByRole('button', { name: '创建角色' }).click()
  const modal = win.locator('.modal.modal-narrow')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input').first().fill(roleName)

  // 勾选两项权限子集（老板本身拥有全部 5 项，故可委派）
  await modal.locator('.check-row', { hasText: '引流工单与重粉库' }).locator('input').check()
  await modal.locator('.check-row', { hasText: '套餐与余额' }).locator('input').check()
  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-30-team-role.png` })

  // 提交
  await modal.locator('.modal-footer .primary-btn').click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 自定义角色列表出现该角色 + 其权限标签（证明真落库）
  await expect(win.getByText(roleName)).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText('引流工单与重粉库 / 套餐与余额')).toBeVisible()

  await app.close()
})
