import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const REPO = resolve(import.meta.dirname, '..', '..')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

// 媒体渲染分支：贴纸(.media-sticker img) 与视频(.media-video video) 各自的气泡渲染。
// media-image 只覆盖 image、group-doc 覆盖 document，sticker/video 此前没测。
test('客户端聊天：贴纸与视频媒体气泡渲染', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  mkdirSync(join(USER_DATA, 'media'), { recursive: true })
  const png = join(REPO, 'branding', 'default', 'icon.png')
  copyFileSync(png, join(USER_DATA, 'media', 'e2e-sticker.png'))
  copyFileSync(png, join(USER_DATA, 'media', 'e2e-video.mp4')) // 元素渲染即可，无需真视频
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:mtypes'
  const store = {
    version: 1,
    conversations: { [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'mtypes', title: '多媒体客户E2E', contactId: 'wa:+15559990077', isGroup: false, lastMessageAt: now, lastMessagePreview: '[视频]', unreadCount: 0 } },
    messages: { [cid]: [
      { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'media', mediaType: 'sticker', mediaId: 'e2e-sticker.png' }, timestamp: now - 1000, status: 'delivered' },
      { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'media', mediaType: 'video', mediaId: 'e2e-video.mp4' }, timestamp: now, status: 'delivered' }
    ] }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-mtypes-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '多媒体客户E2E' }).click()

  // 贴纸：img.media-sticker 加载成功（真实 PNG，naturalWidth>0）
  const sticker = win.locator('.media-sticker')
  await expect(sticker).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => sticker.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0)

  // 视频：video.media-video 元素渲染，src 指向本地媒体协议
  const video = win.locator('.media-video')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('src', /omni-media:\/\/local\/e2e-video\.mp4/)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-111-media-types.png` })
  await app.close()
})
