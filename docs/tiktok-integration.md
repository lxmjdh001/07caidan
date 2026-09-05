# TikTok Business Messaging 接入

WzzScrm 的 TikTok 通道使用官方 TikTok API for Business，不模拟网页版、不收集客户密码。客户在
TikTok 官方网页授权自己的企业号；服务器保存该企业号的 `business_id`，并用 AES-256-GCM 加密保存
短期 access token 与长期 refresh token。桌面客户端不会拿到应用 Secret 或任何 TikTok token。

## 已实现流程

1. 客户端新增 TikTok 账号，点击“网页授权并连接”。
2. 服务器生成 15 分钟有效的随机 state，打开 TikTok Account Holder Authorization。
3. 回调在服务器换取令牌、读取企业号资料、登记 `DIRECT_MESSAGE` Webhook，并加密入主库。
4. 客户端轮询到连接成功后同步最近 90 天会话（每个会话最多取官方接口返回的最近 20 条消息）。
5. 新消息经签名 Webhook 进入租户隔离队列；客户端在线时拉取，离线时服务器保留 7 天。
6. access token 到期前由服务器用 refresh token 自动续期；换电脑登录同一团队会恢复账号。

支持收取文本、图片、视频、贴纸、表情、帖子分享和互动卡片；支持回复文本，以及发送 JPG/PNG
图片（最大 3 MB）。入站图片/视频由服务器携令牌下载，令牌和临时 TikTok URL 不下发桌面端。

## TikTok 开发者后台

在 TikTok API for Business 创建应用并申请 Business Messaging API，至少授权：

- `message.list.read`
- `message.list.send`
- `user.info.basic`
- `user.info.username`
- `user.info.profile`

登记 OAuth 回调：

```text
https://wzzapp.cloud/oauth/tiktok/callback
```

服务端会在首次授权完成时把 `DIRECT_MESSAGE` Webhook 自动更新为：

```text
https://wzzapp.cloud/webhook/tiktok
```

生产环境 `/etc/omnichat/omnichat.env` 添加：

```dotenv
TIKTOK_APP_ID=开发者后台的应用ID
TIKTOK_APP_SECRET=开发者后台的应用Secret
TIKTOK_TOKEN_ENCRYPTION_KEY=至少32位随机密钥
```

然后执行 `deploy/deploy.sh`。可用性只作为布尔值通过 `/api/client/config` 下发；以上三项原文不会
出现在客户端配置、日志或 API 响应中。

## 平台限制

- 只适用于已获 Business Messaging 权限的 TikTok 企业号，不是任意个人号网页版收件箱。
- 企业号不能主动私信陌生用户；只有用户先发起会话后才能回复。
- 官方接口存在回复时间窗与次数限制，WzzScrm 会原样显示平台返回的错误，不绕过风控。
- 官方历史接口覆盖最近 90 天，每个会话最多返回最近 20 条；之后的新消息会持续归档到 WzzScrm 主库。
- 官方发送接口目前只支持文本及符合能力/地区要求的 JPG、PNG 图片，不支持主动发送视频、语音和文件。
