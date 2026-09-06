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
const API = 'http://127.0.0.1:8798'

// M13 运营公告已读持久化：老板点「我知道了」→ markNoticesRead → 该公告标记已读，不再骚扰。
// 大量用例都点「我知道了」清弹窗，但「点完确实标记已读、不再进未读」此前没断言过。
// 逻辑有单测(notify.test)，这里补 UI 点击→服务端持久化的端到端。
test('客户端公告：点「我知道了」后该公告标记已读，不再进未读列表', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const title = `已读测试公告${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 全员公告（返回 id 供末尾自清理，避免遗留活跃公告挡住别的用例）
  const ann = (await fetch(`${API}/api/admin/announcements`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ title, body: '请查收', audience: 'all' })
  }).then((r) => r.json())) as { announcement?: { id: string } }
  const unreadHasMine = async (): Promise<boolean> => {
    const r = (await fetch(`${API}/api/notices`, { headers: { authorization: `Bearer ${reg.token}` } }).then((x) => x.json())) as { announcements?: Array<{ title: string }> }
    return (r.announcements ?? []).some((a) => a.title === title)
  }
  // 登录前：该公告在未读列表里
  expect(await unreadHasMine()).toBe(true)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-anndis-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await win.locator('input[type="email"]').fill(email)
    await win.locator('input[type="password"]').fill('secret123')
    await win.locator('.auth-submit').click()
    await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

    // 公告弹窗出现并显示该公告
    const modal = win.locator('.modal-backdrop').filter({ hasText: '通知' })
    await expect(modal.getByText(title)).toBeVisible({ timeout: 10_000 })

    await win.waitForTimeout(300)
    await win.screenshot({ path: `${SHOT_DIR}/client-announcement-dismiss.png` })

    // 点「我知道了」→ 标记已读
    await win.getByRole('button', { name: '我知道了' }).click()

    // 服务端持久化：该公告不再进未读列表（不会再骚扰）
    await expect.poll(unreadHasMine, { timeout: 10_000 }).toBe(false)
  } finally {
    // 无论用例成败都清理：单条遗留的活跃全员公告会用居中弹层挡住整套用例的点击。
    await app.close().catch(() => undefined)
    if (ann.announcement?.id) {
      await fetch(`${API}/api/admin/announcements/${ann.announcement.id}`, { method: 'DELETE', headers: aAuth }).catch(() => undefined)
    }
  }
})
