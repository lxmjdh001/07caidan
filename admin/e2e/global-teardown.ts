import { execSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 后台(Chromium)套件与电子端套件共享同一持久库。电子端已有 globalTeardown 清客户端侧累积，
 * 但后台套件建的 admin 用户/套餐/通道/AI 供应商模型/工单/订单/支持工单等一直攒着从不清
 * （跑过多次后 plans/channels 已数百行），迟早拖慢"列表渲染"类用例。这里跑完把库重置到
 * 只剩引导管理员(username='admin')，其余事务数据全清；每个用例本就各自自灌，安全。尽力而为。
 */
export default function globalTeardown(): void {
  const db = join(process.env.E2E_DATA_DIR || '/private/tmp/omnichat-e2e-data', 'omnichat.db')
  const sql = [
    // 保留引导管理员，清掉测试造出来的其余管理员与全部会话
    "DELETE FROM admin_users WHERE username != 'admin'",
    'DELETE FROM admin_sessions',
    // 计费：套餐/通道/汇率/AI 供应商与模型/用量/订单/订阅/流水/余额/设置
    'DELETE FROM plans',
    'DELETE FROM payment_channels',
    'DELETE FROM exchange_rates',
    'DELETE FROM ai_providers',
    'DELETE FROM ai_models',
    'DELETE FROM model_usage',
    'DELETE FROM orders',
    'DELETE FROM subscriptions',
    'DELETE FROM ledger',
    'DELETE FROM balances',
    'DELETE FROM billing_settings',
    // 工单/重粉库/推广链接
    'DELETE FROM campaigns',
    'DELETE FROM campaign_links',
    'DELETE FROM entry_links',
    'DELETE FROM fan_libraries',
    'DELETE FROM fan_library_entries',
    // 支持工单
    'DELETE FROM support_tickets',
    'DELETE FROM support_messages',
    // 公告/到期提醒/站内通知
    'DELETE FROM announcements',
    'DELETE FROM announcement_reads',
    'DELETE FROM user_notices',
    'DELETE FROM reminders_sent',
    'DELETE FROM reminder_settings',
    'DELETE FROM email_codes',
    // 客户端侧事务数据（与电子端 teardown 口径一致，避免两套件互相残留）
    'DELETE FROM client_users',
    'DELETE FROM client_sessions',
    'DELETE FROM client_roles',
    'DELETE FROM client_configs',
    'DELETE FROM conversations',
    'DELETE FROM messages',
    'DELETE FROM conversation_intent',
    'DELETE FROM client_logs',
    'DELETE FROM client_log_levels',
    'DELETE FROM media',
    'DELETE FROM line_accounts',
    'DELETE FROM line_events'
  ].join('; ')
  try {
    execSync(`sqlite3 "${db}" "${sql}"`, { stdio: 'ignore' })
  } catch {
    /* 尽力清理，失败忽略 */
  }
}
