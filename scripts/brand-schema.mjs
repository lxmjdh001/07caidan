/**
 * 品牌配置校验（白牌）。
 *
 * 三端各自读同一份 branding/<name>.json：
 *  - client（electron-vite 构建期注入）：appName / shortName / logoText / apiUrl / themeColor …
 *  - admin（vite 构建期注入）：appName / logoText / themeColor …
 *  - server（运行时读取）：appName / company / supportEmail / dashboardTitle
 *  - electron-builder：shortName（appId com.<shortName>.desktop 与 npm name）/ appName
 *
 * 任一端要用的字段缺了或写坏，都要在这里一次性挡住 —— 避免上线才发现“还叫旧名字”
 * 或“客户端连不上后台（apiUrl 空）”。字段是所有端所需的并集。
 */

/** 必填字符串字段（非空） */
const REQUIRED_NONEMPTY = ['appName', 'shortName', 'logoText', 'company', 'dashboardTitle', 'apiUrl', 'themeColor']
/** 必须存在但允许为空字符串的字段 */
const REQUIRED_ALLOW_EMPTY = ['supportEmail']
/** 可选字段 */
const OPTIONAL = ['website']

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
/** electron appId 段与 npm name：小写字母数字，可含连字符，不以连字符开头/结尾 */
const SHORT_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function isHttpUrl(v) {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 校验单个品牌对象。返回错误信息数组（空数组 = 通过）。
 * @param {string} name 品牌名（文件名去扩展）
 * @param {unknown} obj 解析后的 JSON
 */
export function validateBrand(name, obj) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return [`${name}: 顶层必须是对象`]
  }
  const b = obj

  for (const key of REQUIRED_NONEMPTY) {
    const v = b[key]
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`${name}.${key}: 必填且不能为空`)
    }
  }
  for (const key of REQUIRED_ALLOW_EMPTY) {
    if (!(key in b) || typeof b[key] !== 'string') {
      errors.push(`${name}.${key}: 必须存在且为字符串（可为空串）`)
    }
  }
  // 未知字段（拼错的键 = 静默回落，正是要防的）
  const known = new Set([...REQUIRED_NONEMPTY, ...REQUIRED_ALLOW_EMPTY, ...OPTIONAL])
  for (const key of Object.keys(b)) {
    if (!known.has(key)) errors.push(`${name}.${key}: 未知字段（拼写错误？将被各端忽略）`)
  }

  // 格式校验（仅在字段本身存在且为字符串时）
  if (typeof b.shortName === 'string' && b.shortName && !SHORT_NAME.test(b.shortName)) {
    errors.push(`${name}.shortName: 只能小写字母数字与连字符（用于 appId 与 npm name）：得到 "${b.shortName}"`)
  }
  if (typeof b.themeColor === 'string' && b.themeColor && !HEX_COLOR.test(b.themeColor)) {
    errors.push(`${name}.themeColor: 必须是 #RGB 或 #RRGGBB：得到 "${b.themeColor}"`)
  }
  if (typeof b.apiUrl === 'string' && b.apiUrl && !isHttpUrl(b.apiUrl)) {
    errors.push(`${name}.apiUrl: 必须是 http(s) URL：得到 "${b.apiUrl}"`)
  }
  if (typeof b.supportEmail === 'string' && b.supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.supportEmail)) {
    errors.push(`${name}.supportEmail: 邮箱格式不正确：得到 "${b.supportEmail}"`)
  }
  if (typeof b.website === 'string' && b.website && !isHttpUrl(b.website)) {
    errors.push(`${name}.website: 若填写必须是 http(s) URL：得到 "${b.website}"`)
  }
  return errors
}

export const BRAND_FIELDS = { REQUIRED_NONEMPTY, REQUIRED_ALLOW_EMPTY, OPTIONAL }
