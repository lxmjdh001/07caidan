import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { BillingRepo } from '../src/billing/billing-repo.ts'
import { openDb } from '../src/db.ts'
import {
  NotifyRepo,
  matchesAudience,
  parseDays,
  type Announcement,
  type UserProfile
} from '../src/notify/notify-repo.ts'
import { sweepReminders, type ReminderDeps } from '../src/notify/reminder-cron.ts'
import { renderTemplate } from '../src/notify/template.ts'

const T = 't1'
const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0)

let dir: string
let notify: NotifyRepo
let billing: BillingRepo

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-notify-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  notify = new NotifyRepo(db)
  billing = new BillingRepo(db)
})

function ann(over: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    title: 't',
    body: 'b',
    audience: 'all',
    audienceParam: '',
    enabled: true,
    createdAt: NOW,
    ...over
  }
}

function user(over: Partial<UserProfile> = {}): UserProfile {
  return { userId: 1, registeredAt: NOW - 100 * DAY, ...over }
}

describe('模板渲染', () => {
  test('变量替换与空白容忍', () => {
    assert.equal(
      renderTemplate('你好 {{email}}，剩 {{ daysLeft }} 天', { email: 'a@b.c', daysLeft: 3 }),
      '你好 a@b.c，剩 3 天'
    )
  })
  test('缺失变量保留原样 —— 写错变量名要能被看见', () => {
    assert.equal(renderTemplate('套餐 {{planNmae}}', { planName: 'Pro' }), '套餐 {{planNmae}}')
  })
  test('无变量的模板原样返回', () => {
    assert.equal(renderTemplate('纯文本', {}), '纯文本')
  })
})

describe('受众匹配', () => {
  test('all 命中所有人', () => {
    assert.equal(matchesAudience(ann(), user(), NOW), true)
  })
  test('plan：只命中订阅了该套餐的用户', () => {
    const a = ann({ audience: 'plan', audienceParam: 'p1' })
    assert.equal(matchesAudience(a, user({ planId: 'p1' }), NOW), true)
    assert.equal(matchesAudience(a, user({ planId: 'p2' }), NOW), false)
    assert.equal(matchesAudience(a, user(), NOW), false)
  })
  test('new_users：注册 N 天内', () => {
    const a = ann({ audience: 'new_users', audienceParam: '7' })
    assert.equal(matchesAudience(a, user({ registeredAt: NOW - 3 * DAY }), NOW), true)
    assert.equal(matchesAudience(a, user({ registeredAt: NOW - 8 * DAY }), NOW), false)
  })
  test('expiring：N 天内到期；已过期不算', () => {
    const a = ann({ audience: 'expiring', audienceParam: '7' })
    assert.equal(matchesAudience(a, user({ expiresAt: NOW + 3 * DAY }), NOW), true)
    assert.equal(matchesAudience(a, user({ expiresAt: NOW + 10 * DAY }), NOW), false)
    assert.equal(matchesAudience(a, user({ expiresAt: NOW - DAY }), NOW), false)
    assert.equal(matchesAudience(a, user(), NOW), false)
  })
})

describe('parseDays', () => {
  test('中英逗号/空格分隔，去重降序，过滤非法', () => {
    assert.deepEqual(parseDays('7,3，1 3 abc 0 -2 400'), [7, 3, 1])
  })
})

describe('公告存取与已读', () => {
  test('未读列表按受众过滤；标记已读后消失', () => {
    const a = notify.createAnnouncement(T, { title: '全员', body: 'x', audience: 'all' })
    notify.createAnnouncement(T, {
      title: '仅p9',
      body: 'x',
      audience: 'plan',
      audienceParam: 'p9'
    })
    const u = user({ userId: 5 })
    let unread = notify.unreadAnnouncementsFor(T, u, NOW)
    assert.deepEqual(unread.map((x) => x.title), ['全员'])

    notify.markAnnouncementsRead(T, 5, [a.id])
    unread = notify.unreadAnnouncementsFor(T, u, NOW)
    assert.equal(unread.length, 0)
  })

  test('停用的公告不下发', () => {
    const a = notify.createAnnouncement(T, { title: 'x', body: 'x', audience: 'all' })
    notify.updateAnnouncement(T, a.id, { enabled: false })
    assert.equal(notify.unreadAnnouncementsFor(T, user(), NOW).length, 0)
  })

  test('个人通知未读/已读', () => {
    notify.addNotice(T, 5, 'expiry', '快到期', '正文', NOW)
    const list = notify.unreadNotices(T, 5)
    assert.equal(list.length, 1)
    notify.markNoticesRead(T, 5, [list[0]!.id])
    assert.equal(notify.unreadNotices(T, 5).length, 0)
  })

  test('租户隔离', () => {
    notify.createAnnouncement(T, { title: 'x', body: 'x', audience: 'all' })
    assert.equal(notify.unreadAnnouncementsFor('other', user(), NOW).length, 0)
  })
})

describe('到期提醒巡检', () => {
  function deps(over: Partial<ReminderDeps> = {}): ReminderDeps & { mails: string[] } {
    const mails: string[] = []
    return {
      mails,
      billing,
      notify,
      emailOf: () => 'u@test.com',
      sendMail: async (to: string, subject: string) => {
        mails.push(`${to}|${subject}`)
      },
      appName: 'WzzScrm',
      tenants: () => [T],
      ...over
    } as never
  }

  async function setupSub(daysLeft: number): Promise<void> {
    const plan = billing.createPlan(T, {
      name: '专业版',
      priceCents: 0,
      periodUnit: 'day',
      periodCount: daysLeft,
      maxAccounts: 5
    })
    billing.changePlan(T, 9, plan.id, NOW - 0)
  }

  test('未开启时不发', async () => {
    await setupSub(3)
    assert.equal(await sweepReminders(deps(), NOW), 0)
  })

  test('剩余天数进入档位 → 发站内 + 邮件，变量已渲染', async () => {
    await setupSub(3)
    notify.updateReminderConfig(T, { enabled: true, emailEnabled: true })
    const d = deps()
    const n = await sweepReminders(d, NOW)
    assert.equal(n, 1)
    const notices = notify.unreadNotices(T, 9)
    assert.equal(notices.length, 1)
    assert.ok(notices[0]!.title.includes('3 天'), notices[0]!.title)
    assert.ok(notices[0]!.body.includes('专业版'))
    assert.equal(d.mails.length, 1)
    assert.ok(d.mails[0]!.startsWith('u@test.com|'))
  })

  test('幂等：同一到期周期同一档位只发一次', async () => {
    await setupSub(3)
    notify.updateReminderConfig(T, { enabled: true })
    assert.equal(await sweepReminders(deps(), NOW), 1)
    assert.equal(await sweepReminders(deps(), NOW), 0)
    assert.equal(await sweepReminders(deps(), NOW + DAY), 0, '进入更小档位?剩2天仍在3天档,不重发')
  })

  test('只发满足条件的最小档位，不同时发 7 天档和 3 天档', async () => {
    await setupSub(2)
    notify.updateReminderConfig(T, { enabled: true, daysBefore: [7, 3, 1] })
    assert.equal(await sweepReminders(deps(), NOW), 1)
    assert.equal(notify.unreadNotices(T, 9).length, 1)
  })

  test('多档递进：随到期临近逐档各发一次(7→3→1)，绝不漏掉最后一档', async () => {
    // 多档提醒的价值就在「递进」：老板 7 天前收一次、3 天前再收一次、1 天前最后催一次。
    // 去重键含档位(threshold)，所以三档各发一次。若哪天有人把去重键退化成(用户,到期时间)，
    // 就只会发第一档、后续更紧急的 3/1 天档永远不发 —— 用户错过最后催缴。原有用例都只在
    // 单一时刻建单扫一次，抓不到这个递进链路。这里推进时间跨越档位边界，钉死逐档触达。
    await setupSub(7) // 7 天后到期
    notify.updateReminderConfig(T, { enabled: true, daysBefore: [7, 3, 1] })
    const d = deps()

    // ① 此刻剩 7 天 → 只发 7 天档
    assert.equal(await sweepReminders(d, NOW), 1, '7 天档应发')
    assert.equal(await sweepReminders(d, NOW), 0, '同档不重发')
    // ② 推进到剩 ~2.5 天(落在 3 天档窗口内) → 发 3 天档(新的一条)
    assert.equal(await sweepReminders(d, NOW + 4.5 * DAY), 1, '3 天档应发')
    assert.equal(await sweepReminders(d, NOW + 4.5 * DAY), 0, '3 天档不重发')
    // ③ 推进到剩 ~0.5 天(1 天档窗口) → 发最后一档 1 天档
    assert.equal(await sweepReminders(d, NOW + 6.5 * DAY), 1, '1 天档(最后催缴)必须发')

    // 三档共 3 条站内通知，逐级递进、无一遗漏
    assert.equal(notify.unreadNotices(T, 9).length, 3, '应累计 7/3/1 三档共三条')
  })

  test('关邮件开关只发站内', async () => {
    await setupSub(3)
    notify.updateReminderConfig(T, { enabled: true, emailEnabled: false })
    const d = deps()
    await sweepReminders(d, NOW)
    assert.equal(d.mails.length, 0)
    assert.equal(notify.unreadNotices(T, 9).length, 1)
  })

  test('邮件失败不影响站内通知（站内保底）', async () => {
    await setupSub(3)
    notify.updateReminderConfig(T, { enabled: true, emailEnabled: true })
    const d = deps({
      sendMail: async () => {
        throw new Error('SMTP down')
      }
    })
    assert.equal(await sweepReminders(d, NOW), 1)
    assert.equal(notify.unreadNotices(T, 9).length, 1)
  })

  test('远未到期的订阅不发', async () => {
    await setupSub(30)
    notify.updateReminderConfig(T, { enabled: true, daysBefore: [7, 3, 1] })
    assert.equal(await sweepReminders(deps(), NOW), 0)
  })
})
