/**
 * 通知模板渲染。语法：{{变量名}}。
 *
 * 缺失的变量**保留原样**而不是替换成空串 —— 模板写错变量名时，
 * 发出去的邮件里留着 {{planNmae}} 一眼就能看出问题；
 * 悄悄变成空白反而没人发现。
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (raw, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? raw : String(v)
  })
}

/** 到期提醒可用变量清单（管理后台展示给运营抄） */
export const REMINDER_VARS = ['email', 'planName', 'expiresAt', 'daysLeft', 'appName'] as const

/** 默认模板：租户没配过时用它，避免开了提醒却发空邮件 */
export const DEFAULT_REMINDER_SUBJECT = '【{{appName}}】您的套餐将于 {{daysLeft}} 天后到期'
export const DEFAULT_REMINDER_BODY =
  '您好，\n\n您在 {{appName}} 的「{{planName}}」套餐将于 {{expiresAt}}（{{daysLeft}} 天后）到期。\n' +
  '为避免账号配额中断，请及时续费或开启自动续费。\n\n—— {{appName}}'
