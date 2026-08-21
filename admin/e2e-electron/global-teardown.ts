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
  const sql = [
    "DELETE FROM fan_library_entries WHERE library_id IN (SELECT id FROM fan_libraries WHERE name LIKE '%E2E%')",
    "DELETE FROM fan_libraries WHERE name LIKE '%E2E%'",
    "DELETE FROM announcements WHERE title LIKE '%E2E%' OR title LIKE '%测试%'"
  ].join('; ')
  try {
    execSync(`sqlite3 "${db}" "${sql}"`, { stdio: 'ignore' })
  } catch {
    /* 尽力清理，失败忽略 */
  }
}
