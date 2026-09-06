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

test('客户端打粉全链路：建工单→生成分享链接→公开看板可用', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-link-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.getByTitle('添加 WhatsApp 账号').click()
  await win.locator('.picker-item', { hasText: 'WhatsApp' }).click()
  await expect(win.locator('.account-platform-group', { hasText: 'WhatsApp' })).toBeVisible()

  // 建工单
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.getByRole('button', { name: '新建工单' }).first().click()
  await win.locator('input[placeholder="如：八月东南亚推广"]').fill('打粉全链路工单')
  await win.locator('.check-grid .check-item').first().locator('input[type="checkbox"]').check()
  await win.getByRole('button', { name: '新建工单' }).last().click()

  // 打开工单详情 → 生成分享链接
  await win.locator('.campaign-table tbody tr', { hasText: '打粉全链路工单' }).first().getByRole('button', { name: '查看' }).click()
  await expect(win.getByRole('heading', { name: '分享链接' })).toBeVisible({ timeout: 10_000 })
  await win.getByRole('button', { name: '生成链接' }).click()

  // 读取生成的公开链接 token，验证公开看板端点可用
  const url = await win.locator('.link-url').first().textContent({ timeout: 10_000 })
  const token = /\/c\/([a-f0-9]+)/.exec(url ?? '')?.[1]
  expect(token, `未从 ${url} 解析出 token`).toBeTruthy()
  const pub = (await fetch(`${API}/public/campaign/${token}`).then((r) => r.json())) as { campaign?: { name?: string } }
  expect(pub.campaign?.name).toBe('打粉全链路工单')

  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-19-sharelink.png` })
  await app.close()
})
