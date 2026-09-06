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

// M9 分享链接带有效期创建：详情页选「30 天后」预设 → 生成链接 → 链接状态显示「… 到期」（有效非永久）。
// sharelink 建的是默认永久链接、sharelink-expiry 灌的是 API 过期链接，UI 选预设建带期链接此前没测。
test('客户端分享链接：选 30 天后预设创建带有效期链接', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = `${Date.now().toString(36).slice(-5)}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const name = `带期工单${TAG}`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, accountIds: ['main'], accountLabels: { main: '主号' }, startAt: Date.now() - 86_400_000 })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-slce-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.locator('.campaign-table tbody tr', { hasText: name }).getByRole('button', { name: '查看' }).click()

  // 详情分享链接区：填备注 + 选「30 天后」预设 → 生成链接
  await win.locator('label.field', { hasText: '备注' }).locator('input').fill(`月度看板${TAG}`)
  await win.getByRole('button', { name: '30 天后' }).click()
  await win.getByRole('button', { name: '生成链接' }).click()

  // 链接列表出现该链接，状态为「… 到期」（有效期链接，非永不过期/已过期/已撤销）
  const linkRow = win.locator('.link-list li', { hasText: `月度看板${TAG}` })
  await expect(linkRow).toBeVisible({ timeout: 10_000 })
  const state = linkRow.locator('.link-state')
  await expect(state).toContainText('到期', { timeout: 10_000 })
  await expect(state).not.toContainText('永不过期')
  await expect(state).not.toContainText('已过期')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-99-sharelink-create-expiry.png` })
  await app.close()
})
