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

// M9 打粉判重核心：建 whatsapp 重粉库 → 建工单配「规则一(库) + 规则二(时间)」→ 重开编辑核对已落库
test('客户端引流工单：配置判重库+时间规则并核对持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-dedup-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()

  // ① 先建一个 whatsapp 重粉库（导入 3 个号码）作判重规则一的素材
  await win.getByRole('button', { name: '重粉库' }).click()
  const libCard = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  await libCard.getByRole('button', { name: '导入名单' }).click()
  await libCard.locator('input[type="text"]').first().fill('判重库E2E')
  await libCard.locator('textarea').first().fill('+15551110001\n+15551110002\n+15551110003')
  await libCard.getByRole('button', { name: '导入建库' }).click()
  await expect(win.getByText('判重库E2E').first()).toBeVisible({ timeout: 10_000 })

  // ② 回工单页，新建工单：选默认 WhatsApp 主账号
  await win.locator('.page-tabs button', { hasText: '工单' }).click()
  await win.getByRole('button', { name: '新建工单' }).first().click()
  await win.locator('input[placeholder="如：八月东南亚推广"]').fill('判重配置工单E2E')
  await win.locator('section.form-card').filter({ hasText: '判重规则' }).waitFor()
  // 选账号（基础卡的第一个账号勾选框 = whatsapp:main）
  await win.locator('.check-grid .check-item').first().locator('input[type="checkbox"]').check()

  // ③ 规则一：勾选刚建的判重库（同平台 whatsapp，可选）
  const dedupCard = win.locator('section.form-card').filter({ hasText: '判重规则' })
  await dedupCard.locator('.check-item', { hasText: '判重库E2E' }).locator('input[type="checkbox"]').check()
  // ④ 规则二：设判重时间点为「今天」→ 统计范围单选出现
  await dedupCard.getByRole('button', { name: '今天' }).click()
  await expect(dedupCard.getByText('全部账号')).toBeVisible()
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-31-campaign-dedup.png` })

  // 提交
  await win.getByRole('button', { name: '新建工单' }).last().click()
  await expect(win.getByText('判重配置工单E2E').first()).toBeVisible({ timeout: 10_000 })

  // ⑤ 重开编辑：判重库勾选仍在 → 证明 dedupLibraryIds 真落库
  await win.locator('.campaign-row', { hasText: '判重配置工单E2E' }).click()
  await win.getByRole('button', { name: '编辑工单' }).click()
  const editDedup = win.locator('section.form-card').filter({ hasText: '判重规则' })
  await expect(
    editDedup.locator('.check-item', { hasText: '判重库E2E' }).locator('input[type="checkbox"]')
  ).toBeChecked({ timeout: 10_000 })

  await app.close()
})
