import type { ChannelPlugin } from '../registry'
import { LineAdapter } from './line-adapter'
import { LinePollCoordinator } from './poll-coordinator'

/** 整机唯一的轮询协调器；首个 LINE 账号创建，后续复用 */
let sharedPoller: LinePollCoordinator | undefined

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
    sharedPoller ??= new LinePollCoordinator(() => {
      const b = ctx.getBackend()
      return { url: b.url, token: b.token }
    }, ctx.logger)
    return new LineAdapter({
      poller: sharedPoller,
      accountId,
      logger: ctx.logger,
      getCreds: () => ({
        channelAccessToken: ctx.getAccountConfig().credentials?.channelAccessToken,
        channelSecret: ctx.getAccountConfig().credentials?.channelSecret,
        providerId: ctx.getAccountConfig().credentials?.providerId
      }),
      getBackend: ctx.getBackend,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      saveMedia: ctx.saveMedia
    })
  }
}
