# X 与 Snapchat 官方消息接入

## X Direct Messages

OmniChat 使用 X 官方 OAuth 2.0 Authorization Code + PKCE。客户新增 X 账号后只需在 X 网页确认授权，
无需填写 Client ID、Secret 或 token。服务器以 AES-256-GCM 保存 access/refresh token，桌面端只读取
账号摘要和私信数据；同一团队换电脑后会自动恢复账号。

X 开发者应用需配置回调地址：

```text
https://wzzapp.cloud/oauth/x/callback
```

授权范围：

```text
dm.read dm.write tweet.read users.read offline.access media.write
```

服务器环境变量：

```text
X_CLIENT_ID=...
X_CLIENT_SECRET=...
X_TOKEN_ENCRYPTION_KEY=至少32位随机字符串
```

接入支持读取历史私信、增量接收、发送文本和 JPG/PNG/WebP 图片、用户名称/公开 `@username` 与头像。
X 的 DM 查询有严格用户级限流，客户端按 75 秒间隔拉取；如果以后购买支持 Account Activity 的层级，
可以再启用 Webhook 降低延迟。

## Snapchat Public Profile Messaging

Snapchat 没有面向第三方的普通个人聊天 API。当前官方 Messaging API 只服务品牌 Public Profile 与
创作者之间的合作沟通，而且应用需要通过 Snap 联系人单独加入准入名单。OmniChat 在产品名称和授权页
明确标为“Snapchat（创作者合作）”，不会伪装成普通 Snapchat 收件箱。

开发者后台回调地址：

```text
https://wzzapp.cloud/oauth/snapchat/callback
```

服务器环境变量：

```text
SNAPCHAT_CLIENT_ID=...
SNAPCHAT_CLIENT_SECRET=...
SNAPCHAT_TOKEN_ENCRYPTION_KEY=至少32位随机字符串
```

客户授权品牌 Public Profile 后，在账号设置的“创作者 Public Profile ID”中填写一个或多个创作者 ID
（逗号分隔）。服务器会通过官方接口获取/创建合作会话，并把会话 token 加密保存到主库。因此换电脑后，
已经绑定的创作者会话仍会恢复。官方接口当前只支持文本消息；媒体发送按钮不会对该渠道开放。

## 安全与隔离

- 应用 Secret、平台 access/refresh token、Snapchat conversation token 都不会下发桌面端。
- 所有账号和会话表都同时按 `tenant + owner_id + account_id` 隔离。
- OAuth state 15 分钟过期，X 使用 PKCE S256；解绑会删除账号令牌和相应 Snapchat 会话 token。
- 客户端配置的代理仅用于头像/媒体下载；官方 API 调用从服务器发出。
