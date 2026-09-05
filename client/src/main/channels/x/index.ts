import type { ChannelPlugin } from '../registry'
import { XAdapter } from './x-adapter'

export const xPlugin: ChannelPlugin = {
  kind: 'x',
  displayName: 'X',
  authType: 'oauth',
  createAdapter(accountId, ctx) {
    return new XAdapter({
      accountId,
      logger: ctx.logger,
      getBackend: ctx.getBackend,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      saveMedia: ctx.saveMedia,
      openExternal: ctx.openOAuth
    })
  }
}
