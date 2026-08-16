import { deviceIdentity } from '../whatsapp/device-identity'
import type { ChannelPlugin } from '../registry'
import { resolveApiApp } from './api-app'
import { TelegramUserAdapter } from './telegram-user-adapter'

/**
 * Telegram 普通账号（MTProto）。打粉主用渠道 —— 相比 Bot 无机器人标记、可被加好友、
 * 投放时给个人号链接转化更好。
 *
 * 凭证说明：apiId/apiHash 是**应用级**凭证（标识软件本身，不是用户），由发行方内置，
 * 普通用户只需要输手机号 + 验证码。这里的两个字段是高级覆盖项，量大的客户可以填自己的
 * api_id 做隔离，详见 api-app.ts。登录后的会话串由适配器自动写入 credentials.session。
 */
export const telegramUserPlugin: ChannelPlugin = {
  kind: 'telegram',
  displayName: 'Telegram（账号）',
  authType: 'phone_code',
  credentialFields: [
    { key: 'apiId', label: 'API ID', placeholder: '留空用软件内置', advanced: true },
    { key: 'apiHash', label: 'API Hash', secret: true, advanced: true }
  ],
  createAdapter(accountId, ctx) {
    const creds = (): Record<string, string> => ctx.getAccountConfig().credentials ?? {}
    return new TelegramUserAdapter({
      accountId,
      logger: ctx.logger,
      getApiCredentials: () => resolveApiApp(creds(), ctx.getDefaults?.() ?? {}),
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
