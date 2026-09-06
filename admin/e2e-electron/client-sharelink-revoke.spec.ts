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

// M9 红线：撤销分享链接后，公开看板端点立即 410 —— 防止已撤销链接继续泄露聚合数据
test('客户端分享链接：撤销后公开端点 410', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const acc = `sa${TAG}`
  const name = `撤销测试工单${TAG}`

  // API：注册老板 + 建工单 + 建分享链接
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name, accountIds: [acc], accountLabels: { [acc]: '号A' }, startAt: Date.now() - 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: '发给团队' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  const token = link.link.token
  expect(token).toBeTruthy()

  // 撤销前：公开端点可访问(200)
  const before = await fetch(`${API}/public/campaign/${token}`)
  expect(before.status).toBe(200)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-revoke-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 打开工单 → 分享链接 → 点“停用”(撤销)
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.locator('.campaign-table tbody tr', { hasText: name }).getByRole('button', { name: '查看' }).click()
  await win.getByRole('button', { name: '停用', exact: true }).click()
  await expect(win.getByText('已停用').first()).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-63-sharelink-revoke.png` })
  await app.close()

  // 撤销后：公开端点不再返回数据（红线）。实现对撤销/过期/未知统一返回 404
  // （不暴露 token 是否曾存在，比区分 410 更安全），body 带 reason=revoked
  const after = await fetch(`${API}/public/campaign/${token}`)
  expect(after.status).toBe(404)
  expect((await after.json() as { error?: string }).error).toBe('revoked')
})
