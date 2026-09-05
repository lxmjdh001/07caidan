import type { ChannelPlugin } from '../registry'
import { MetaAdapter } from './meta-adapter'
import type { MetaChannel } from './mapper'

function plugin(channel: MetaChannel, displayName: string): ChannelPlugin {
  return {
    kind: channel,
    displayName,
    authType: 'oauth',
    createAdapter(accountId, ctx) {
      return new MetaAdapter({
        channel,
        accountId,
        logger: ctx.logger,
        getBackend: ctx.getBackend,
        getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
        saveMedia: ctx.saveMedia,
        openExternal: ctx.openOAuth
      })
    }
  }
}

export const facebookPlugin = plugin('facebook', 'Facebook Messenger')
export const instagramPlugin = plugin('instagram', 'Instagram')
