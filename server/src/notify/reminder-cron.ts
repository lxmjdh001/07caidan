import type { BillingRepo } from '../billing/billing-repo.ts'
import type { NotifyRepo } from './notify-repo.ts'
import { renderTemplate } from './template.ts'

export interface ReminderDeps {
  billing: BillingRepo
  notify: NotifyRepo
  /** 用户 id → 邮箱（发邮件用；查不到只发站内） */
  emailOf: (tenant: string, userId: number) => string | undefined
  sendMail: (to: string, subject: string, body: string) => Promise<void>
  appName: string
  tenants: () => string[]
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }
}

const DAY = 86_400_000

/**
 * 到期提醒巡检。
 *
 * 对每个生效订阅、每档提前天数：剩余天数 ≤ 档位且未发过 → 发。
 * 去重键是 (用户, 档位, 到期时间) —— 续费后 expiresAt 变了，
 * 新周期自然重新有资格收提醒，不用手动清历史。
 *
 * 邮件失败不回滚站内通知：站内是保底，邮件是加强。
 */
export async function sweepReminders(deps: ReminderDeps, now = Date.now()): Promise<number> {
  let sent = 0
  for (const tenant of deps.tenants()) {
    const cfg = deps.notify.reminderConfig(tenant)
    if (!cfg.enabled || cfg.daysBefore.length === 0) continue
    const maxDays = Math.max(...cfg.daysBefore)

    for (const sub of deps.billing.listExpiringSubscriptions(tenant, now + maxDays * DAY, now)) {
      const daysLeft = Math.ceil((sub.expiresAt - now) / DAY)
      // 只发满足条件的最小档位：剩 2 天时发"3 天档"，不再重复发"7 天档"
      const threshold = cfg.daysBefore.filter((d) => daysLeft <= d).sort((a, b) => a - b)[0]
      if (threshold === undefined) continue
      if (!deps.notify.tryMarkReminderSent(tenant, sub.userId, threshold, sub.expiresAt, now)) {
        continue
      }

      const plan = deps.billing.getPlan(tenant, sub.planId)
      const vars = {
        email: deps.emailOf(tenant, sub.userId) ?? '',
        planName: plan?.name ?? sub.planId,
        expiresAt: new Date(sub.expiresAt).toLocaleString('zh-CN'),
        daysLeft,
        appName: deps.appName
      }
      const subject = renderTemplate(cfg.emailSubject, vars)
      const body = renderTemplate(cfg.emailBody, vars)

      deps.notify.addNotice(tenant, sub.userId, 'expiry', subject, body, now)
      sent++

      if (cfg.emailEnabled && vars.email) {
        try {
          await deps.sendMail(vars.email, subject, body)
        } catch (err) {
          deps.logger?.warn({ userId: sub.userId, err: String(err) }, '到期提醒邮件发送失败')
        }
      }
    }
  }
  return sent
}
