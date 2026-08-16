import { createHash } from 'node:crypto'
import { Browsers } from 'baileys'

/**
 * 按账号派生 WhatsApp Web 设备标识（Linked Devices 里显示的名字）。
 *
 * 设计原则：
 * - 各账号不同：从 accountId 确定性派生，避免多账号共用同一设备名而被关联。
 * - 单账号稳定：同一账号每次重连派生结果一致（设备名频繁变化反而可疑）。
 *
 * 注意：加密设备身份（registration id / Noise / Signal 密钥）由各账号独立的
 * authDir 天然隔离，这里只处理对外可见的设备名字符串这一层。
 */

type BrowserTuple = [string, string, string]

/** 候选操作系统家族（用 Baileys 内置的版本号，保持真实感） */
const OS_BUILDERS: Array<(browser: string) => BrowserTuple> = [
  Browsers.macOS as (b: string) => BrowserTuple,
  Browsers.windows as (b: string) => BrowserTuple,
  Browsers.ubuntu as (b: string) => BrowserTuple
]

/** 候选浏览器名 */
const BROWSERS = ['Chrome', 'Firefox', 'Edge', 'Safari', 'Opera', 'Brave']

function hashInt(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 8)
  return parseInt(hex, 16)
}

/**
 * 返回该账号的 browser 三元组 [os, browser, osVersion]。
 * customLabel 非空时作为浏览器名（用户可在账号设置里自定，仍保持账号间不同的 OS）。
 */
export function deviceIdentity(accountId: string, customLabel?: string): BrowserTuple {
  const h = hashInt(accountId)
  const os = OS_BUILDERS[h % OS_BUILDERS.length]!
  const browser = customLabel?.trim() || BROWSERS[Math.floor(h / OS_BUILDERS.length) % BROWSERS.length]!
  return os(browser)
}
