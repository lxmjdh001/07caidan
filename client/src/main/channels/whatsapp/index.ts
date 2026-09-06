import { join } from 'node:path'
import type { ChannelPlugin } from '../registry'
import { WhatsAppAdapter } from './whatsapp-adapter'

export const whatsAppPlugin: ChannelPlugin = {
  kind: 'whatsapp',
  displayName: 'WhatsApp',
  authType: 'qr',
  createAdapter(accountId, ctx) {
    return new WhatsAppAdapter({
      accountId,
      authDir: join(ctx.dataDir, 'auth', accountId),
      logger: ctx.logger,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      getDeviceLabel: () => ctx.getAccountConfig().deviceLabel,
      getFingerprintSeed: () => ctx.getAccountConfig().fingerprint?.seed,
      onAuthStateChanged: ctx.notifyEnvironmentChanged,
      saveMedia: ctx.saveMedia
    })
  }
}
