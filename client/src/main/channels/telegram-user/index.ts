import { deviceIdentity } from '../whatsapp/device-identity'
import type { ChannelPlugin } from '../registry'
import { TelegramUserAdapter } from './telegram-user-adapter'

/**
 * Telegram 普通账号（MTProto）。打粉主用渠道 —— 相比 Bot 无机器人标记、可被加好友、
 * 投放时给个人号链接转化更好。
 *
 * 凭证说明：apiId/apiHash 是**应用级**凭证（my.telegram.org 申请），可在此按账号覆盖以进一步隔离；
 * 留空则用全局设置里的默认值。登录后的会话串由适配器自动写入 credentials.session。
 */
export const telegramUserPlugin: ChannelPlugin = {
  kind: 'telegram',
  displayName: 'Telegram（账号）',
  authType: 'phone_code',
  credentialFields: [
    { key: 'apiId', label: 'API ID（留空用默认）', placeholder: 'my.telegram.org 申请' },
    { key: 'apiHash', label: 'API Hash（留空用默认）', secret: true }
  ],
  createAdapter(accountId, ctx) {
    const creds = (): Record<string, string> => ctx.getAccountConfig().credentials ?? {}
    return new TelegramUserAdapter({
      accountId,
      logger: ctx.logger,
      getApiCredentials: () => {
        const c = creds()
        const fallback = ctx.getDefaults?.() ?? {}
        const apiId = c.apiId || fallback.telegramApiId
        const apiHash = c.apiHash || fallback.telegramApiHash
        return { apiId: apiId ? Number(apiId) : undefined, apiHash: apiHash || undefined }
      },
      getSession: () => creds().session,
      saveSession: (session, phone) =>
        ctx.saveCredentials({ ...creds(), session, ...(phone ? { phone } : {}) }),
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      // 复用 WhatsApp 的设备标识派生：各账号稳定且互不相同，用于多账号防关联
      getDeviceFingerprint: () => {
        const [systemVersion, deviceModel, appVersion] = deviceIdentity(
          accountId,
          ctx.getAccountConfig().deviceLabel
        )
        return { deviceModel, systemVersion, appVersion }
      },
      saveMedia: ctx.saveMedia
    })
  }
}
