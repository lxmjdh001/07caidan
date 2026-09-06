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

// 健壮性：某会话缺 unreadCount（旧数据/部分同步）时，未读聚合角标不能显示 NaN。
// 修复前 reduce(sum + c.unreadCount) 遇 undefined 得 NaN，且 NaN<=0 为 false 故角标照渲染 NaN。
test('客户端未读聚合：会话缺 unreadCount 时角标不显示 NaN', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const cidA = 'whatsapp:main:hasunread'
  const cidB = 'whatsapp:main:nounread'
  const store = {
    version: 1,
    conversations: {
      [cidA]: { id: cidA, channel: 'whatsapp', accountId: 'main', externalChatId: 'hasunread', title: '有未读客户E2E', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi', unreadCount: 3 },
      // 故意省略 unreadCount，模拟旧数据/部分同步
      [cidB]: { id: cidB, channel: 'whatsapp', accountId: 'main', externalChatId: 'nounread', title: '缺字段客户E2E', isGroup: false, lastMessageAt: now - 1000, lastMessagePreview: 'hey' }
    },
    messages: {
      [cidA]: [{ id: 'a1', channel: 'whatsapp', accountId: 'main', conversationId: cidA, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now, status: 'delivered' }],
      [cidB]: [{ id: 'b1', channel: 'whatsapp', accountId: 'main', conversationId: cidB, direction: 'in', body: { type: 'text', text: 'hey' }, timestamp: now - 1000, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-nanguard-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 全部消息聚合角标 = 3（缺字段会话按 0 计），绝不显示 NaN
  const allBadge = win.locator('.account-row.all .unread-badge')
  await expect(allBadge).toHaveText('3', { timeout: 10_000 })
  await expect(win.getByText('NaN')).toHaveCount(0)
  // 有未读会话有数字角标；缺字段会话按 0 计 → 无角标（不显示空/NaN 角标）
  await win.locator('.account-row.all').click()

  await expect(win.locator('.conversation-item', { hasText: '有未读客户E2E' }).locator('.unread-badge')).toHaveText('3')
  await expect(win.locator('.conversation-item', { hasText: '缺字段客户E2E' }).locator('.unread-badge')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-109-unread-nan-guard.png` })
  await app.close()
})
