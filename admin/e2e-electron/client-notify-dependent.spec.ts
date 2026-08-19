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

// M1 通知设置的主/子联动：关掉主开关「窗口未聚焦时弹系统通知」→ 「显示消息内容」「提示音」
// 两个子开关变灰不可点；持久化后重开仍如此；再开主开关子开关恢复可用。
// notify-settings 只覆盖了关闭 preview 的持久化，主/子 disabled 联动此前没测。
test('客户端通知设置：主开关关闭时子开关联动禁用并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-notifd-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '设置' }).click()
  const master = win.locator('label.field.checkbox', { hasText: '窗口未聚焦时弹系统通知' }).locator('input')
  const preview = win.locator('label.field.checkbox', { hasText: '通知中显示消息内容' }).locator('input')
  const sound = win.locator('label.field.checkbox', { hasText: '通知提示音' }).locator('input')

  // 默认三开关都开、子开关可点
  await expect(master).toBeChecked({ timeout: 10_000 })
  await expect(preview).toBeEnabled()
  await expect(sound).toBeEnabled()

  // 关主开关 → 两个子开关立刻变禁用
  await master.uncheck()
  await expect(preview).toBeDisabled()
  await expect(sound).toBeDisabled()

  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-89-notify-dependent.png` })

  // 离开再回来：主开关关态与子开关禁用态都保持（落库）
  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  const master2 = win.locator('label.field.checkbox', { hasText: '窗口未聚焦时弹系统通知' }).locator('input')
  const preview2 = win.locator('label.field.checkbox', { hasText: '通知中显示消息内容' }).locator('input')
  await expect(master2).not.toBeChecked({ timeout: 10_000 })
  await expect(preview2).toBeDisabled()

  // 再开主开关 → 子开关恢复可点
  await master2.check()
  await expect(preview2).toBeEnabled()
  await expect(win.locator('label.field.checkbox', { hasText: '通知提示音' }).locator('input')).toBeEnabled()

  await app.close()
})
