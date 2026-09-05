import type { ChannelPlugin } from '../registry'
import { TikTokAdapter } from './tiktok-adapter'

export const tiktokPlugin: ChannelPlugin = {
  kind: 'tiktok',
  displayName: 'TikTok',
  authType: 'oauth',
  createAdapter(accountId, ctx) {
    return new TikTokAdapter({
      accountId,
      logger: ctx.logger,
      getBackend: ctx.getBackend,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      saveMedia: ctx.saveMedia,
      openExternal: ctx.openOAuth
    })
  }
}
