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

// M9 老板在客户端查看工单真实统计（服务端计算的进线数在客户端 CampaignDetail 展示）
test('客户端引流工单：打开工单看到服务端计算的进线统计', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const email = `boss_${TAG}@e2e.test`
  const acc = `sa${TAG}`
  const contact = `wa:+1777${TAG.replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6)}`
  const convId = `whatsapp:${acc}:${contact}`
  const name = `进线统计工单${TAG}`

  // API 先注册老板 + 同步一条入线会话 + 建工单（服务端据此算进线）
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  await fetch(`${API}/api/sync`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      conversations: [{ id: convId, channel: 'whatsapp', accountId: acc, contactId: contact, title: '客户甲', isGroup: false, lastMessageAt: now - 3600_000 }],
      messages: [{ externalId: `${convId}:in`, conversationId: convId, channel: 'whatsapp', accountId: acc, direction: 'in', bodyType: 'text', text: '你好', timestamp: now - 3600_000 }]
    })
  })
  await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name, accountIds: [acc], accountLabels: { [acc]: '主号甲' }, startAt: now - 2 * 86_400_000 })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-cstats-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 用同一老板账号登录客户端 UI（默认登录态，不点注册切换）
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

  // CampaignDetail 统计卡：进线总数 = 1（服务端按唯一账号算出）
  const totalCard = win.locator('.stat-card').filter({ hasText: '进线总数' })
  await expect(totalCard.locator('.v')).toHaveText('1', { timeout: 10_000 })
  // 新粉卡也在（去重后有效）
  await expect(win.locator('.stat-card').filter({ hasText: '新粉' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-48-campaign-stats.png` })
  await app.close()
})
