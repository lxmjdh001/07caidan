import type { ChannelPlugin } from '../registry'
import { LineAdapter } from './line-adapter'

export const linePlugin: ChannelPlugin = {
  kind: 'line',
  displayName: 'LINE',
  authType: 'credentials',
  credentialFields: [
    { key: 'channelAccessToken', label: 'Channel Access Token', secret: true },
    { key: 'channelSecret', label: 'Channel Secret', secret: true }
  ],
  createAdapter(accountId, ctx) {
    return new LineAdapter({
      accountId,
      logger: ctx.logger,
      getCreds: () => ({
        channelAccessToken: ctx.getAccountConfig().credentials?.channelAccessToken,
        channelSecret: ctx.getAccountConfig().credentials?.channelSecret
      }),
      getBackend: ctx.getBackend,
      saveMedia: ctx.saveMedia
    })
  }
}
