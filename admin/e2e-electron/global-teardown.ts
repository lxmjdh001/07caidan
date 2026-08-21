import { execSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 共享持久库里 E2E 测试数据会跨运行累积，拖慢/污染后续用例：
 * - 重粉库（fan_libraries）：每次导入建库都留一条，攒到几十条会拖慢重粉库 UI → 假性 flaky
 * - 全员公告（announcements）：遗留的活跃公告弹层会挡住点击（用例内已 finally 兜底，这里再兜一层）
 * 每次跑完统一清掉 E2E 名下的这些行，让下次从干净状态开始。尽力而为，失败忽略。
 */
export default function globalTeardown(): void {
  const db = join(process.env.E2E_DATA_DIR || '/private/tmp/omnichat-e2e-data', 'omnichat.db')
  // 该库是纯 E2E 数据库，用例各自自成一体（不跨用例共享数据）。跑完把累积的事务性数据
  // 清空，防跨运行无限累积拖慢扫全表的查询（如 fanlib-export 的历史导出扫会话、设备总览扫用户）。
  // 只清事务数据，保留 schema 与后台管理员账号。
  const sql = [
    'DELETE FROM fan_library_entries',
    'DELETE FROM fan_libraries',
    'DELETE FROM announcements',
    'DELETE FROM conversations',
    'DELETE FROM messages',
    'DELETE FROM client_logs',
    'DELETE FROM client_sessions',
    'DELETE FROM client_users'
  ].join('; ')
  try {
    execSync(`sqlite3 "${db}" "${sql}"`, { stdio: 'ignore' })
  } catch {
    /* 尽力清理，失败忽略 */
  }
}
