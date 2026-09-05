import type { ChannelPlugin } from '../registry'
import { SnapchatAdapter } from './snapchat-adapter'

export const snapchatPlugin: ChannelPlugin = {
  kind: 'snapchat',
  displayName: 'Snapchat（创作者合作）',
  authType: 'oauth',
  credentialFields: [{
    key: 'creatorProfileIds',
    label: '创作者 Public Profile ID',
    placeholder: '多个 ID 用逗号分隔；可授权后再填写'
  }],
  createAdapter(accountId, ctx) {
    return new SnapchatAdapter({
      accountId,
      logger: ctx.logger,
      getBackend: ctx.getBackend,
      getCreatorProfileIds: () => ctx.getAccountConfig().credentials?.creatorProfileIds,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      saveMedia: ctx.saveMedia,
      openExternal: ctx.openOAuth
    })
  }
}
