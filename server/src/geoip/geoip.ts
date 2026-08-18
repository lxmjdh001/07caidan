import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 离线 GeoIP：只判「中国大陆 / 香港 / 其他」三态，服务公开看板的地区访问限制。
 *
 * 数据来自 APNIC 官方分配表（src/geoip/ranges.json，由 gen-ranges.py 生成），
 * 完全离线 —— 公开链接的每次访问都要判定，不能依赖第三方查询接口的延迟与配额。
 */

export type Region = 'CN' | 'HK' | 'other'

interface Ranges {
  /** [startInt, endInt, region][]，按 start 升序 */
  v4: Array<[number, number, Region]>
  /** [prefix, prefixLen, region][] */
  v6: Array<[string, number, Region]>
}

let cache: { v4: Array<[number, number, Region]>; v6: Array<[bigint, bigint, Region]> } | null =
  null

function load(): NonNullable<typeof cache> {
  if (cache) return cache
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = JSON.parse(readFileSync(join(here, 'ranges.json'), 'utf8')) as Ranges
  // v6 预展开成 [网络前缀值, 掩码] 的 BigInt，比较时按位与
  const v6 = raw.v6.map(([prefix, len, region]): [bigint, bigint, Region] => {
    const val = ipv6ToBigInt(prefix)
    const mask = len === 0 ? 0n : (~0n << BigInt(128 - len)) & ((1n << 128n) - 1n)
    return [val & mask, mask, region]
  })
  cache = { v4: raw.v4, v6 }
  return cache
}

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!
}

function ipv6ToBigInt(ip: string): bigint {
  // 展开 :: 缩写
  let head = ip
  let tail = ''
  const dc = ip.indexOf('::')
  if (dc >= 0) {
    head = ip.slice(0, dc)
    tail = ip.slice(dc + 2)
  }
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - headParts.length - tailParts.length
  const groups = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts]
  let v = 0n
  for (const g of groups) v = (v << 16n) | BigInt(parseInt(g || '0', 16))
  return v
}

/** 判定 IP 属地。识别 ::ffff:a.b.c.d 形式的 IPv4 映射地址。 */
export function regionOf(ip: string): Region {
  const trimmed = ip.trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed)
  const v4str = mapped ? mapped[1]! : trimmed
  const v4 = ipv4ToInt(v4str)
  const data = load()
  if (v4 !== null) {
    // 二分查找区间
    let lo = 0
    let hi = data.v4.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [s, e, r] = data.v4[mid]!
      if (v4 < s) hi = mid - 1
      else if (v4 > e) lo = mid + 1
      else return r
    }
    return 'other'
  }
  if (trimmed.includes(':')) {
    try {
      const v = ipv6ToBigInt(trimmed)
      for (const [net, mask, r] of data.v6) {
        if ((v & mask) === net) return r
      }
    } catch {
      return 'other'
    }
  }
  return 'other'
}

/** 公开看板访问是否放行（默认拒绝大陆与香港，用户可逐项放开） */
export function regionAllowed(
  ip: string,
  opts: { allowCn: boolean; allowHk: boolean }
): boolean {
  const region = regionOf(ip)
  if (region === 'CN') return opts.allowCn
  if (region === 'HK') return opts.allowHk
  return true
}
