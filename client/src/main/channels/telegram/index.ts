import type { ChannelPlugin } from '../registry'
import { TelegramAdapter } from './telegram-adapter'

/** Telegram Bot（Bot Token 登录）。打粉主用普通账号，此项供客服机器人等场景备用。 */
export const telegramBotPlugin: ChannelPlugin = {
  kind: 'telegram_bot',
  displayName: 'Telegram Bot',
  authType: 'credentials',
  credentialFields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      placeholder: '123456:ABC-DEF...（@BotFather 获取）',
      secret: true
    }
  ],
  createAdapter(accountId, ctx) {
    return new TelegramAdapter({
      accountId,
      logger: ctx.logger,
      getBotToken: () => ctx.getAccountConfig().credentials?.botToken,
      saveMedia: ctx.saveMedia
    })
  }
}
