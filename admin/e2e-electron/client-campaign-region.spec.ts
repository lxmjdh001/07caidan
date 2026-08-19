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

// 工单公开看板地区限制（默认拒绝大陆/香港）——客户端新建工单时勾选「允许中国大陆 IP 访问」
// 应落库 allowCnIp=true、allowHkIp 保持默认 false，且重开工单时复选框回显持久态。
test('客户端工单：地区限制勾选允许大陆并持久化回显', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const email = `boss_${TAG}@e2e.test`
  const name = `地区工单${TAG}`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-region-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '新建工单' }).first().click()

  await win.locator('input[placeholder="如：八月东南亚推广"]').fill(name)
  await win.locator('.check-grid .check-item').first().locator('input[type="checkbox"]').check()

  // 默认两个地区都不勾（拒绝）→ 勾上「允许中国大陆 IP 访问」，香港保持关闭
  const cnBox = win.locator('label.check-row', { hasText: '允许中国大陆 IP 访问' }).locator('input')
  const hkBox = win.locator('label.check-row', { hasText: '允许香港 IP 访问' }).locator('input')
  await expect(cnBox).not.toBeChecked()
  await expect(hkBox).not.toBeChecked()
  await cnBox.check()
  await expect(cnBox).toBeChecked()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-83-campaign-region.png` })

  await win.getByRole('button', { name: '新建工单' }).last().click()
  await expect(win.getByText(name).first()).toBeVisible({ timeout: 10_000 })

  // 落库校验：allowCnIp=true、allowHkIp=false
  const camps = (await fetch(`${API}/api/campaigns`, { headers: { authorization: `Bearer ${reg.token}` } }).then((r) => r.json())) as { campaigns?: Array<{ name: string; allowCnIp?: boolean; allowHkIp?: boolean }> }
  const mine = (camps.campaigns ?? []).find((c) => c.name === name)
  expect(mine, '工单应已创建').toBeTruthy()
  expect(mine?.allowCnIp).toBe(true)
  expect(mine?.allowHkIp).toBe(false)

  // 重开工单 → 详情 → 编辑 → 复选框回显持久态（大陆勾选、香港未勾）
  await win.locator('.campaign-row', { hasText: name }).click()
  await win.getByRole('button', { name: '编辑工单' }).click()
  const cnBox2 = win.locator('label.check-row', { hasText: '允许中国大陆 IP 访问' }).locator('input')
  const hkBox2 = win.locator('label.check-row', { hasText: '允许香港 IP 访问' }).locator('input')
  await expect(cnBox2).toBeChecked({ timeout: 10_000 })
  await expect(hkBox2).not.toBeChecked()

  await app.close()
})
