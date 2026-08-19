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

// M2 会话设置：手动指定客户语言（覆盖自动检测）→ 持久化（关开弹层仍在）
test('客户端会话设置：手动指定客户语言并持久化', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:convset'
  const store = {
    version: 1,
    conversations: {
      [cid]: {
        id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'convset',
        title: '语言设置客户E2E', contactId: 'wa:+15559990002', isGroup: false,
        lastMessageAt: now, lastMessagePreview: 'hola', unreadCount: 0
      }
    },
    messages: {
      [cid]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          body: { type: 'text', text: 'hola, cuánto cuesta' }, timestamp: now, status: 'delivered' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-convset-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 关掉可能的启动公告弹窗
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.conversation-item', { hasText: '语言设置客户E2E' }).click()

  // 打开会话设置弹层
  await win.locator('.conv-settings-btn').click()
  const popover = win.locator('.conv-settings-popover')
  await expect(popover).toBeVisible({ timeout: 10_000 })
  const langSel = popover.locator('select')
  await expect(langSel).toHaveValue('') // 默认自动

  // 手动指定一个具体客户语言
  await langSel.selectOption({ index: 1 })
  const chosen = await langSel.inputValue()
  expect(chosen).not.toBe('')
  // 等 conversation:updated 事件回灌，弹层内 AI 自动回复开关也在
  await expect(popover.locator('input[type="checkbox"]')).toBeVisible()
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-34-conv-settings.png` })

  // 持久化：关闭再打开弹层，指定语言仍在（证明经主进程落库并回灌）
  await win.locator('.conv-settings-btn').click()
  await expect(popover).toBeHidden()
  await win.locator('.conv-settings-btn').click()
  await expect(win.locator('.conv-settings-popover select')).toHaveValue(chosen)

  await app.close()
})
