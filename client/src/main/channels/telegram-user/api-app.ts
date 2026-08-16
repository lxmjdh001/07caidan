/**
 * Telegram 应用级凭证（api_id / api_hash）。
 *
 * 这不是「用户凭证」，而是**软件本身**的身份 —— MTProto 协议要求每个客户端程序
 * 带一对 api_id/api_hash，用来标识「这是哪个 App」，跟登录的是谁无关。Telegram
 * Desktop、各种第三方开源客户端也都是各自内置一对，终端用户从来不用去申请。
 *
 * 所以正确做法是发行方（本软件）在 my.telegram.org 注册一次，把凭证打包进构建，
 * 用户只需要输手机号 + 验证码。账号设置里的 apiId/apiHash 是高级覆盖项，默认留空。
 *
 * 打包时通过环境变量注入：
 *   OMNI_TG_API_ID=xxxxx OMNI_TG_API_HASH=xxxx npm run build
 *
 * 关于要不要给每个租户配不同的 api_id：同一个 api_id 下挂大量做拉新的账号时，
 * Telegram 可能对该 App 整体加限制，波及所有用它登录的账号。量大的客户建议在
 * 全局设置里填自己的 api_id 做隔离 —— 这也是保留覆盖入口的原因。
 */

/** 构建时注入的内置凭证；未注入时为空，回落到用户配置 */
export const BUILTIN_TG_API_ID = process.env.OMNI_TG_API_ID ?? ''
export const BUILTIN_TG_API_HASH = process.env.OMNI_TG_API_HASH ?? ''

export interface TgApiApp {
  apiId?: number
  apiHash?: string
}

/**
 * 按「账号覆盖 > 全局设置 > 内置默认」的顺序解析应用凭证。
 * apiId 必须是正整数，脏数据（空串/非数字）一律当没配。
 */
export function resolveApiApp(
  account: { apiId?: string; apiHash?: string },
  global: { telegramApiId?: string; telegramApiHash?: string },
  builtin: { apiId?: string; apiHash?: string } = {
    apiId: BUILTIN_TG_API_ID,
    apiHash: BUILTIN_TG_API_HASH
  }
): TgApiApp {
  const rawId = account.apiId?.trim() || global.telegramApiId?.trim() || builtin.apiId?.trim() || ''
  const hash =
    account.apiHash?.trim() || global.telegramApiHash?.trim() || builtin.apiHash?.trim() || ''
  const apiId = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
  return {
    apiId: Number.isSafeInteger(apiId) && apiId > 0 ? apiId : undefined,
    apiHash: hash || undefined
  }
}

/** 是否具备可用的应用凭证（决定要不要提示用户去配） */
export function hasApiApp(app: TgApiApp): boolean {
  return app.apiId !== undefined && app.apiHash !== undefined
}
