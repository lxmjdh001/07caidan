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

// M10 推广链接删除：已保存链接点删除（window.confirm）→ deleteEntryLink → 从列表消失。
// promolink-save 只覆盖保存，删除此前没测。备注唯一避免共享 tenant 累积。
test('客户端推广链接：删除已保存链接从列表消失', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-pld-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const note = `待删推广${Date.now().toString(36).slice(-5)}`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.locator('.page-tabs button', { hasText: '推广链接' }).click()

  // 保存一条链接
  await win.locator('label.field', { hasText: '账号联系方式' }).locator('input').fill('8613800138000')
  await win.locator('label.field', { hasText: '追踪码' }).locator('input').fill('fb0002')
  await win.locator('label.field', { hasText: '来源备注' }).locator('input').fill(note)
  await win.getByRole('button', { name: '保存此链接' }).click()

  // 已保存列表出现该条
  const saved = win.locator('section.form-card').filter({ hasText: '已保存的推广链接' })
  const row = saved.locator('li', { hasText: note })
  await expect(row).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-94-promolink-delete.png` })

  // 点该条删除 → 从列表消失
  await row.getByRole('button', { name: '删除' }).click()
  await expect(saved.locator('li', { hasText: note })).toHaveCount(0, { timeout: 10_000 })

  await app.close()
})
