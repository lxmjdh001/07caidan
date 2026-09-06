import { test, expect, _electron as electron } from '@playwright/test'
import { createServer, type Server } from 'node:http'
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
const API = 'http://127.0.0.1:8798'

function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body: { text?: string; target_lang?: string } = {}
        try { body = JSON.parse(raw) } catch { /* ignore */ }
        resp.writeHead(200, { 'content-type': 'application/json' })
        resp.end(JSON.stringify({ text: `EN[${body.target_lang}] ${body.text}`, source_lang: 'zh' }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      res({ server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` })
    })
  })
}

// 聊天输入键盘行为：Shift+Enter 换行不发送，Enter 发送（触发发送前预览）。
// outbound-preview 用点「发送」按钮触发；键盘 Enter/Shift+Enter 这条交互此前没测。
test('客户端聊天：Enter 发送、Shift+Enter 换行不发送', async () => {
  const stub = await startStub()
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
    locale: 'zh-CN',
    translation: { engine: 'custom-http', outboundEnabled: true, inboundEnabled: false, confirmBeforeSend: true, custom: { url: stub.url, apiKey: '' } }
  }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:kbd'
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify({
    version: 1,
    conversations: { [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'kbd', title: '键盘客户E2E', contactId: 'wa:+15559990033', langOverride: 'en', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi' } },
    messages: { [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: 'hello?' }, timestamp: now, status: 'delivered' }] }
  }), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-kbd-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const gift = await fetch(`${API}/api/admin/entitlements-adjust`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, characters: 10_000, note: 'e2e translation allowance' })
  })
  expect(gift.ok, `赠送字符应成功: ${await gift.clone().text()}`).toBeTruthy()
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.account-row.all').click()

  await win.locator('.conversation-item', { hasText: '键盘客户E2E' }).click()
  const ta = win.locator('.composer textarea')
  await ta.click()
  await ta.type('在吗')

  // Shift+Enter：换行，不触发发送 → 预览面板不出现，草稿变多行
  await ta.press('Shift+Enter')
  await ta.type('现在有货吗')
  await expect(win.locator('.send-preview')).toHaveCount(0)
  await expect(ta).toHaveValue('在吗\n现在有货吗')

  // Enter：触发发送 → 出现发送前预览面板
  await ta.press('Enter')
  await expect(win.locator('.send-preview')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-106-composer-enter.png` })
  await app.close()
  await new Promise<void>((r) => stub.server.close(() => r()))
})
