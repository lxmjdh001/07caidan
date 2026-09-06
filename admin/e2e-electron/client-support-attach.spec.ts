import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const REPO = resolve(import.meta.dirname, '..', '..')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

// M18 客户端提交工单时通过 UI 附加截图：点「附加截图」→ 选图 → 按钮变「✓ 已附加截图」→ 提交建单。
// ticket-upload 只在渲染端 evaluate 造字节测 IPC 完整性，UI 附件按钮这条交互此前没测。
test('客户端帮助与反馈：提交工单时 UI 附加截图', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-supatt-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const title = `贴图反馈${Date.now().toString(36).slice(-5)}`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-support').click()
  await win.getByRole('button', { name: '提交问题' }).first().click()

  await win.locator('.form-page input[type="text"]').first().fill(title)
  await win.locator('textarea').first().fill('界面异常，随单附一张截图说明。')

  // 点「附加截图」→ 拦截文件选择器 → 选本地图片
  const [chooser] = await Promise.all([
    win.waitForEvent('filechooser'),
    win.getByRole('button', { name: '附加截图' }).click()
  ])
  await chooser.setFiles(join(REPO, 'branding', 'default', 'icon.png'))

  // 附件按钮变「✓ 已附加截图」
  await expect(win.getByRole('button', { name: /已附加截图/ })).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-105-support-attach.png` })

  // 提交 → 列表出现该工单
  await win.getByRole('button', { name: '提交', exact: true }).click()
  await expect(win.getByText(title).first()).toBeVisible({ timeout: 10_000 })

  await app.close()
})
