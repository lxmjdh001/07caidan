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

// M13 会话级 AI 自动回复开关：在会话设置里开启并持久化（两层开关的会话层）
test('客户端会话设置：会话级 AI 自动回复开关持久化', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:arconv'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'arconv', title: '自动回复客户E2E', contactId: 'wa:+15559990007', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi', unreadCount: 0 }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-arconv-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '自动回复客户E2E' }).click()
  await win.locator('.conv-settings-btn').click()
  const popover = win.locator('.conv-settings-popover')
  await expect(popover).toBeVisible({ timeout: 10_000 })

  // 会话级 AI 自动回复开关，默认关 → 打开
  const ar = popover.locator('label.checkbox', { hasText: 'AI 自动回复本会话' }).locator('input[type="checkbox"]')
  await expect(ar).not.toBeChecked()
  // 受控组件(checked=conversation.autoReply)：用 click 而非 check——check 会校验
  // 即时状态变化，但受控组件点后会用旧 prop 瞬时重渲染回原态，直到主进程落库+
  // conversation:updated 事件回灌才稳定为选中
  await ar.click()
  await expect(ar).toBeChecked({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-66-conv-autoreply.png` })

  // 关闭再打开弹层：仍为开启
  await win.locator('.conv-settings-btn').click()
  await expect(popover).toBeHidden()
  await win.locator('.conv-settings-btn').click()
  await expect(
    win.locator('.conv-settings-popover').locator('label.checkbox', { hasText: 'AI 自动回复本会话' }).locator('input[type="checkbox"]')
  ).toBeChecked()

  await app.close()
})
