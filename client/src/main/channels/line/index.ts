import type { ChannelPlugin } from '../registry'
import { LineAdapter } from './line-adapter'

export const linePlugin: ChannelPlugin = {
  kind: 'line',
  displayName: 'LINE',
  authType: 'credentials',
  credentialFields: [
    { key: 'channelAccessToken', label: 'Channel Access Token', secret: true },
    { key: 'channelSecret', label: 'Channel Secret', secret: true },
    { key: 'providerId', label: 'Provider ID（判重用，同 Provider 的账号填一样）' }
  ],
  createAdapter(accountId, ctx) {
    return new LineAdapter({
      accountId,
      logger: ctx.logger,
      getCreds: () => ({
        channelAccessToken: ctx.getAccountConfig().credentials?.channelAccessToken,
        channelSecret: ctx.getAccountConfig().credentials?.channelSecret,
        providerId: ctx.getAccountConfig().credentials?.providerId
      }),
      getBackend: ctx.getBackend,
      saveMedia: ctx.saveMedia
    })
  }
}
