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

// M17 运营公告：管理员发全员公告 → 客户端启动弹窗展示标题+正文 → 关闭标已读
test('客户端启动公告：展示后台发布的公告并可关闭', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const title = `系统维护通知${TAG}`
  const body = `今晚 02:00 例行维护约 10 分钟，届时可能短暂断连。编号${TAG}`

  // 管理员发全员公告
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const create = await fetch(`${API}/api/admin/announcements`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, body, audience: 'all' })
  })
  expect(create.ok).toBeTruthy()
  const annId = (await create.json() as { announcement: { id: string } }).announcement.id

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-ann-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
    await win.locator('.auth-switch button').first().click()
    await win.locator('input[type="email"]').fill(email)
    await win.locator('input[type="password"]').fill('secret123')
    await win.locator('.auth-submit').click()
    await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

    // 启动公告弹窗展示该公告标题与正文
    const modal = win.locator('.modal-backdrop').filter({ hasText: '通知' })
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.notice-item h3', { hasText: title })).toBeVisible()
    await expect(win.getByText(body)).toBeVisible()

    await win.waitForTimeout(300)
    await win.screenshot({ path: `${SHOT_DIR}/client-50-announcement.png` })

    // 关闭即标已读 → 弹窗消失
    await win.getByRole('button', { name: '我知道了' }).click()
    await expect(modal).toBeHidden({ timeout: 10_000 })
  } finally {
    // 无论成败都删掉这条活跃全员公告：遗留会用弹窗遮挡后续所有用例的点击（已知污染源）。
    await app.close().catch(() => undefined)
    await fetch(`${API}/api/admin/announcements/${annId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${admin.token}` }
    }).catch(() => undefined)
  }
})
