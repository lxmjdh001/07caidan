import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

/** 兜底删除该标题的全员公告：UI 删除是 happy-path，用例中途失败会遗留活跃公告污染 client 用例。 */
async function purgeAnnouncement(title: string): Promise<void> {
  try {
    const at = (await fetch(`${API}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    }).then((r) => r.json())).token as string
    const list = (await fetch(`${API}/api/admin/announcements`, { headers: { authorization: `Bearer ${at}` } }).then((r) => r.json())) as { announcements?: Array<{ id: string; title: string }> }
    for (const a of (list.announcements ?? []).filter((x) => x.title === title)) {
      await fetch(`${API}/api/admin/announcements/${a.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${at}` } })
    }
  } catch { /* 兜底清理，失败忽略 */ }
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台运营公告：发布公告并在列表核对', async ({ page }) => {
  // 用唯一标题 + 用完即删：全员公告若遗留会持续弹通知框，拦截其它客户端用例的点击
  const title = `E2E 公告测试_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  page.on('dialog', (d) => void d.accept())

  try {
    await login(page)
    await page.getByRole('button', { name: /运营公告|Announcements/ }).click()

    const card = page.locator('section.card').filter({ hasText: /发布公告|New announcement/i })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('input').first().fill(title)
    await card.locator('textarea').first().fill('这是一条端到端测试公告，受众默认全部用户。')
    await card.getByRole('button', { name: '发布' }).click()

    // 已发布列表出现该公告
    const row = page.locator('table tbody tr').filter({ hasText: title })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/admin-announcement.png`, fullPage: true })

    // 自清理：删除该公告，避免遗留的启用全员公告污染后续 client spec 的通知弹窗
    await row.getByRole('button', { name: '删除' }).click()
    await expect(page.locator('table tbody tr').filter({ hasText: title })).toHaveCount(0, { timeout: 10_000 })
  } finally {
    // 兜底：即便上面中途失败，也按标题从服务端删干净（遗留活跃全员公告会毒化 client 用例）
    await purgeAnnouncement(title)
  }
})
