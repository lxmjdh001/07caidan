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

function conv(ext: string, title: string, now: number): [string, object] {
  const id = `whatsapp:main:${ext}`
  return [id, { id, channel: 'whatsapp', accountId: 'main', externalChatId: ext, title, isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi', unreadCount: 0 }]
}

// 会话列表搜索：按标题实时过滤
test('客户端会话列表：搜索框按标题实时过滤', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const [aId, aConv] = conv('apple', '苹果客户E2E', now)
  const [bId, bConv] = conv('banana', '香蕉客户E2E', now - 1000)
  const store = {
    version: 1,
    conversations: { [aId]: aConv, [bId]: bConv },
    messages: {
      [aId]: [{ id: 'a1', channel: 'whatsapp', accountId: 'main', conversationId: aId, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now, status: 'delivered' }],
      [bId]: [{ id: 'b1', channel: 'whatsapp', accountId: 'main', conversationId: bId, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now - 1000, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-search-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 两条会话都在
  await expect(win.locator('.conversation-item')).toHaveCount(2, { timeout: 10_000 })

  // 搜「苹果」→ 只剩苹果客户
  const search = win.locator('.sidebar-search input')
  await search.fill('苹果')
  await expect(win.locator('.conversation-item')).toHaveCount(1)
  await expect(win.getByText('苹果客户E2E')).toBeVisible()
  await expect(win.getByText('香蕉客户E2E')).toHaveCount(0)
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-39-conv-search.png` })

  // 清空 → 两条都回来
  await search.fill('')
  await expect(win.locator('.conversation-item')).toHaveCount(2)

  await app.close()
})
