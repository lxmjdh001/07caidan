# Facebook Messenger / Instagram 接入

OmniChat 使用 Meta 官方接口，不模拟 Facebook 或 Instagram 网页客户端。

## 客户体验

1. 在 OmniChat 选择 Facebook Messenger 或 Instagram。
2. 点击“网页授权并连接”。
3. 在 Facebook / Instagram 官方页面登录并确认授权。
4. 授权页关闭后，客户端自动连接、同步会话并接收 Webhook 新消息。

客户不填写 App ID、App Secret 或访问令牌。令牌由服务器使用 AES-256-GCM 加密保存，桌面端只能读取
账号公开摘要、会话和消息。同一老板及其客服团队在另一台电脑登录 OmniChat 后，会自动恢复这些账号。

## 服务器一次性配置

在 Meta 开发者后台创建 Business 应用，启用 Messenger 与 Instagram API，并配置：

- OAuth Redirect URI：`https://wzzapp.cloud/oauth/meta/callback`
- Webhook Callback URL：`https://wzzapp.cloud/webhook/meta`
- Webhook Verify Token：与服务器 `META_WEBHOOK_VERIFY_TOKEN` 完全相同
- Facebook 权限：`pages_show_list`、`pages_messaging`、`pages_manage_metadata`、`pages_read_engagement`
- Instagram 权限：`instagram_business_basic`、`instagram_business_manage_messages`

生产环境 `/etc/omnichat/omnichat.env`：

```dotenv
META_APP_ID=
META_APP_SECRET=
META_INSTAGRAM_APP_ID=
META_INSTAGRAM_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
META_LOGIN_CONFIG_ID=
META_TOKEN_ENCRYPTION_KEY=
META_GRAPH_VERSION=v26.0
```

`META_TOKEN_ENCRYPTION_KEY` 至少 32 个随机字符，部署后不得随意更换，否则已有令牌无法解密。

## 平台限制

- Instagram 只支持专业账号（Business / Creator），不支持普通个人账号。
- 客户必须先主动联系主页或 Instagram 专业账号，回复窗口与可发送内容受 Meta 平台政策限制。
- 给非应用管理员/测试员的真实客户使用前，需要在 Meta 后台完成 Business Verification 和相应权限的
  Advanced Access / App Review。
- Instagram 群聊不受当前官方消息 API 支持。

官方参考：

- [Meta Messenger Platform API](https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api)
- [Meta Instagram API](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api)
