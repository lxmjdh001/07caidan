import type { ChannelPlugin } from '../registry'
import { TelegramAdapter } from './telegram-adapter'

export const telegramPlugin: ChannelPlugin = {
  kind: 'telegram',
  displayName: 'Telegram',
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
