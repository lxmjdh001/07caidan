import { join } from 'node:path'
import type { ChannelPlugin } from '../registry'
import { WhatsAppAdapter } from './whatsapp-adapter'

export const whatsAppPlugin: ChannelPlugin = {
  kind: 'whatsapp',
  displayName: 'WhatsApp',
  createAdapter(accountId, ctx) {
    return new WhatsAppAdapter({
      accountId,
      authDir: join(ctx.dataDir, 'auth', accountId),
      logger: ctx.logger,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl
    })
  }
}
