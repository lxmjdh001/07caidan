import type { ChannelPlugin } from '../registry'
import { KakaoTalkAdapter } from './kakaotalk-adapter'

export const kakaoTalkPlugin: ChannelPlugin = {
  kind: 'kakaotalk',
  displayName: 'KakaoTalk',
  authType: 'credentials',
  credentialFields: [
    {
      key: 'email',
      label: 'Kakao 账号（邮箱）',
      placeholder: 'name@example.com'
    },
    {
      key: 'password',
      label: 'Kakao 密码（仅首次验证使用）',
      secret: true
    }
  ],
  createAdapter(accountId, ctx) {
    return new KakaoTalkAdapter({
      accountId,
      logger: ctx.logger,
      getCredentials: () => ctx.getAccountConfig().credentials,
      saveCredentials: ctx.saveCredentials,
      getProxyUrl: () => ctx.getAccountConfig().proxyUrl,
      getFingerprint: () => ctx.getAccountConfig().fingerprint
    })
  }
}
