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

// 会话列表按最近消息时间倒序（最新在最上）。这是打粉客服的核心排序，此前无 e2e。
test('客户端会话列表：按最近消息时间倒序排列', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const mk = (n: string, ago: number) => {
    const id = `whatsapp:main:${n}`
    return {
      conv: { id, channel: 'whatsapp', accountId: 'main', externalChatId: n, title: `${n}客户E2E`, isGroup: false, lastMessageAt: now - ago, lastMessagePreview: 'hi', unreadCount: 0 },
      msg: { id: `${n}1`, channel: 'whatsapp', accountId: 'main', conversationId: id, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now - ago, status: 'delivered' }
    }
  }
  // 旧(3s前) / 中(2s前) / 新(1s前)
  const old = mk('旧', 3000), mid = mk('中', 2000), fresh = mk('新', 1000)
  const store = {
    version: 1,
    conversations: { [old.conv.id]: old.conv, [mid.conv.id]: mid.conv, [fresh.conv.id]: fresh.conv },
    messages: { [old.conv.id]: [old.msg], [mid.conv.id]: [mid.msg], [fresh.conv.id]: [fresh.msg] }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-sort-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.account-row.all').click()

  const items = win.locator('.conversation-item')
  await expect(items).toHaveCount(3, { timeout: 10_000 })
  // 最新在最上：新 → 中 → 旧
  await expect(items.nth(0)).toContainText('新客户E2E')
  await expect(items.nth(1)).toContainText('中客户E2E')
  await expect(items.nth(2)).toContainText('旧客户E2E')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-112-conv-sort.png` })
  await app.close()
})
