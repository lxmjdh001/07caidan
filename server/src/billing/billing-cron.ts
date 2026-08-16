import type { Logger } from 'pino'
import type { BillingRepo } from './billing-repo.ts'
import type { OrderRepo } from './order-repo.ts'

export interface CronDeps {
  billing: BillingRepo
  orders: OrderRepo
  /** 需要巡检的租户列表（当前部署为单租户） */
  tenants: () => string[]
  logger?: Pick<Logger, 'info' | 'warn'>
}

export interface SweepResult {
  renewed: number
  expired: number
  ordersExpired: number
}

/**
 * 计费定时任务：到期订阅的续费/过期 + 超时订单清理。
 *
 * 拆成纯函数 sweep() + 定时器两层：巡检逻辑本身可以直接在测试里
 * 用固定时间调用，不必和 setInterval 纠缠。
 *
 * 幂等性说明：renew/expireIfDue 内部都带状态条件，同一时刻跑两遍
 * 不会重复扣费 —— 所以进程重启后立刻补跑一次也是安全的。
 */
export function sweepBilling(deps: CronDeps, now = Date.now()): SweepResult {
  const result: SweepResult = { renewed: 0, expired: 0, ordersExpired: 0 }

  for (const tenant of deps.tenants()) {
    for (const sub of deps.billing.listDueSubscriptions(tenant, now)) {
      if (sub.autoRenew) {
        const r = deps.billing.renew(tenant, sub.userId, now)
        if (r.ok) {
          result.renewed++
          deps.logger?.info({ tenant, userId: sub.userId }, '订阅自动续费成功')
        } else {
          // renew 失败时内部已把订阅标记为过期
          result.expired++
          deps.logger?.warn({ tenant, userId: sub.userId, reason: r.reason }, '自动续费失败，订阅已过期')
        }
      } else if (deps.billing.expireIfDue(tenant, sub.userId, now)) {
        result.expired++
      }
    }

    result.ordersExpired += deps.orders.expireStale(tenant, now)
  }

  return result
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** 启动定时巡检；返回停止函数。启动时立即跑一遍，补上停机期间漏掉的到期。 */
export function startBillingCron(deps: CronDeps): () => void {
  const run = (): void => {
    try {
      const r = sweepBilling(deps)
      if (r.renewed || r.expired || r.ordersExpired) {
        deps.logger?.info(r, '计费巡检完成')
      }
    } catch (err) {
      deps.logger?.warn({ err: String(err) }, '计费巡检失败，下轮重试')
    }
  }
  run()
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  // 不阻止进程退出
  timer.unref?.()
  return () => clearInterval(timer)
}
