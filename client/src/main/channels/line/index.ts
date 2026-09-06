import { join } from 'node:path'
import type { ChannelPlugin } from '../registry'
import { LineAdapter } from './line-adapter'

export const linePlugin: ChannelPlugin = {
  kind: 'line',
  displayName: 'LINE',
  authType: 'qr',
  createAdapter(accountId, ctx) {
    return new LineAdapter({
      accountId,
      logger: ctx.logger,
      sessionFile: join(ctx.dataDir, 'sessions', `${accountId}.json`),
      getAuthToken: () => ctx.getAccountConfig().credentials?.authToken,
      saveAuthToken: async (authToken) => ctx.saveCredentials(authToken ? { authToken } : {}),
      onSessionChanged: ctx.notifyEnvironmentChanged,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      saveMedia: ctx.saveMedia
    })
  }
}
