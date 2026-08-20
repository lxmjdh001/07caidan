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

// M3 统一收件箱按账号筛选：点某账号 → 会话列表只剩该账号的会话；点「全部消息」→ 全回来。
// multichannel 只覆盖「全部消息」聚合视图的渠道标签，点账号切换过滤此前没测。
test('客户端统一收件箱：点账号筛选只看该账号会话，全部消息聚合', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
    locale: 'zh-CN',
    accounts: { 'whatsapp:main': {}, 'telegram:tg1': { label: 'TG客服', credentials: { botToken: '123:FAKE' } } }
  }), 'utf8')
  const now = Date.now()
  const waId = 'whatsapp:main:wacust'
  const tgId = 'telegram:tg1:tgcust'
  const store = {
    version: 1,
    conversations: {
      [waId]: { id: waId, channel: 'whatsapp', accountId: 'main', externalChatId: 'wacust', title: 'WA客户E2E', contactId: 'wa:+15551', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi wa', unreadCount: 0 },
      [tgId]: { id: tgId, channel: 'telegram', accountId: 'tg1', externalChatId: 'tgcust', title: 'TG客户E2E', contactId: 'tg:555', isGroup: false, lastMessageAt: now - 1000, lastMessagePreview: 'hi tg', unreadCount: 0 }
    },
    messages: {
      [waId]: [{ id: 'a1', channel: 'whatsapp', accountId: 'main', conversationId: waId, direction: 'in', body: { type: 'text', text: 'hi wa' }, timestamp: now, status: 'delivered' }],
      [tgId]: [{ id: 'b1', channel: 'telegram', accountId: 'tg1', conversationId: tgId, direction: 'in', body: { type: 'text', text: 'hi tg' }, timestamp: now - 1000, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-acctfilter-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  const waConv = win.locator('.conversation-item', { hasText: 'WA客户E2E' })
  const tgConv = win.locator('.conversation-item', { hasText: 'TG客户E2E' })
  const allRow = win.locator('.account-row.all')
  const waAccRow = win.locator('.account-row:not(.all)').first() // whatsapp:main 恒排最前
  const tgAccRow = win.locator('.account-row', { hasText: 'TG客服' })

  // 默认「全部消息」：两账号会话都在
  await expect(waConv).toBeVisible({ timeout: 10_000 })
  await expect(tgConv).toBeVisible()

  // 点 Telegram 账号 → 只剩 TG 会话
  await tgAccRow.click()
  await expect(tgConv).toBeVisible({ timeout: 10_000 })
  await expect(waConv).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-account-filter.png` })

  // 点 WhatsApp 账号 → 只剩 WA 会话
  await waAccRow.click()
  await expect(waConv).toBeVisible({ timeout: 10_000 })
  await expect(tgConv).toHaveCount(0)

  // 点「全部消息」→ 两条都回来
  await allRow.click()
  await expect(waConv).toBeVisible({ timeout: 10_000 })
  await expect(tgConv).toBeVisible()

  await app.close()
})
