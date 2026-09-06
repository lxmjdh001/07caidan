import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const clientRequire = createRequire(join(CLIENT_DIR, 'package.json'))
const ELECTRON_PATH = clientRequire('electron') as string

// BRAND=e2e 的 appName = 'WzzScrm E2E'；应用固定把 userData 指到 appData/<appName>
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

/** 预置一条阿拉伯语会话（含收发各一条），用于校验 RTL 气泡方向与时间戳位置 */
function seedArabicConversation(): void {
  const convId = 'whatsapp:acc1:99900001@s.whatsapp.net'
  const now = Date.now()
  const store = {
    version: 1,
    conversations: {
      [convId]: {
        id: convId,
        channel: 'whatsapp',
        accountId: 'acc1',
        externalChatId: '99900001@s.whatsapp.net',
        title: 'RTL عميل',
        isGroup: false,
        lastMessageAt: now,
        lastMessagePreview: 'نعم، متاح الآن!',
        unreadCount: 0
      }
    },
    messages: {
      [convId]: [
        {
          id: 'm1',
          channel: 'whatsapp',
          accountId: 'acc1',
          conversationId: convId,
          direction: 'in',
          body: { type: 'text', text: 'مرحبا، هل هذا المنتج متاح؟' },
          timestamp: now - 60_000,
          status: 'delivered'
        },
        {
          id: 'm2',
          channel: 'whatsapp',
          accountId: 'acc1',
          conversationId: convId,
          direction: 'out',
          body: { type: 'text', text: 'نعم، متاح الآن! هل ترغب بالطلب؟' },
          timestamp: now - 30_000,
          status: 'read'
        }
      ]
    }
  }
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  // locale=ar 让应用启动即 RTL；覆盖 settings 也清掉上次运行的登录令牌
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'ar' }), 'utf8')
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')
}

test('客户端 RTL：阿拉伯语下气泡收发方向与时间戳镜像', async () => {
  seedArabicConversation()
  const userDataDir = join(tmpdir(), 'omni-rtl-ignored')
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, OMNI_USER_DATA: USER_DATA }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 注册（结构选择器，与语言无关）
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()

  // 进主界面：根节点应为 rtl（App 依据 locale=ar 设置 documentElement.dir）
  await win.locator('.account-row.all').click()

  await expect(win.locator('.conversation-item').first()).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => win.evaluate(() => document.documentElement.dir), { timeout: 10_000 })
    .toBe('rtl')
  await win.locator('.conversation-item').first().click()
  await expect(win.locator('.bubble').first()).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(500)
  await win.screenshot({ path: `${SHOT_DIR}/client-03-rtl-chat.png` })

  await app.close()
})
