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

// 媒体未下载态：媒体消息尚无本地文件（mediaId 缺失）时，气泡显示占位「[图片] 说明」而非破图。
// media-image 测的是已下载图片渲染；未下载/下载中的占位态此前没测。
test('客户端聊天：媒体未下载时显示占位（不破图）', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:pending'
  const store = {
    version: 1,
    conversations: { [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'pending', title: '待下载客户E2E', contactId: 'wa:+15559990066', isGroup: false, lastMessageAt: now, lastMessagePreview: '[图片]', unreadCount: 0 } },
    // 媒体消息但无 mediaId（未下载/下载中）
    messages: { [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'media', mediaType: 'image', caption: '现货实拍E2E' }, timestamp: now, status: 'delivered' }] }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-pending-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '待下载客户E2E' }).click()
  // 占位态：出现 .media-pending 含「[图片] 现货实拍E2E」，且不渲染 <img.media-img>
  await expect(win.locator('.media-pending')).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.media-pending')).toContainText('[图片] 现货实拍E2E')
  await expect(win.locator('.media-img')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-110-media-pending.png` })
  await app.close()
})
