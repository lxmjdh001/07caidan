/**
 * i18n 覆盖率核心（纯函数，便于测试）。
 * 从 locale 源码正则抽取键名，与规范键集（zh-CN 定义 MessageKey）对比，算缺失。
 */

/** 从一个 locale TS 源码里抽取所有 'key': 形式的键名 */
export function extractKeys(source) {
  const set = new Set()
  const re = /'([a-zA-Z][a-zA-Z0-9_.]*)':/g
  let m
  while ((m = re.exec(source)) !== null) set.add(m[1])
  return set
}

/**
 * 覆盖率：给定规范键集与某 locale 键集，返回缺失键与百分比。
 * @param {Set<string>} canonical
 * @param {Set<string>} localeKeys
 */
export function coverage(canonical, localeKeys) {
  const missing = [...canonical].filter((k) => !localeKeys.has(k)).sort()
  const total = canonical.size
  const present = total - missing.length
  return { total, present, missing, pct: total === 0 ? 100 : Math.round((present / total) * 1000) / 10 }
}
