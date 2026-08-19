import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 后台新建用户重名护栏：建已存在用户名 → 服务端 409「用户名已存在」→ 前端 alert 该文案。
// user-create 只覆盖成功新建；重名报错依赖上一轮 req() 错误提取修复才可读（否则 alert「HTTP 409」）。
test('后台用户管理：重名用户创建被拒并提示用户名已存在', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const username = `dupuser${TAG}`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 先建一个该用户名
  const first = await fetch(`${API}/api/users`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret12345', role: 'viewer' })
  })
  expect(first.ok).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: /用户管理|Users/ }).click()
  await page.getByRole('button', { name: /新增用户|Add user/ }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input:not([type="password"])').first().fill(username)
  await modal.locator('input[type="password"]').fill('secret12345')

  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOT_DIR}/admin-user-create-duplicate.png`, fullPage: true })

  // 重名提交 → 弹 alert，文案为「用户名已存在」（修复前会是 HTTP 409）
  const dialogText = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message())
      void d.accept()
    })
  })
  await modal.locator('.modal-actions button').last().click()
  expect(await dialogText).toContain('用户名已存在')
})
