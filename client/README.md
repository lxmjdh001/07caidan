# OmniChat

多平台聚合聊天桌面客户端（Windows / macOS），面向跨境客服场景：
一个收件箱聚合 WhatsApp、Telegram、LINE、KakaoTalk、Facebook Messenger、Instagram、TikTok、X、Snapchat 等平台的会话，聊天内容双向自动翻译。

WhatsApp、Telegram、LINE、KakaoTalk 的个人账号协议连接跑在客户端本地。Messenger 与 Instagram
使用 Meta 官方 OAuth/Graph API，令牌由服务器加密托管；客户只在官方网页授权。
TikTok 使用官方 API for Business，企业号 access/refresh token 同样只在服务器加密托管。
X 使用官方 OAuth 2.0 / Direct Messages API；Snapchat 使用官方 Public Profile Messaging。

## 技术栈

- Electron + electron-vite + React 19 + TypeScript（ESM 全家桶）
- WhatsApp：[Baileys v7](https://github.com/WhiskeySockets/Baileys)（WebSocket 直连，无需浏览器）
- KakaoTalk：[@lukim9-kakao/client-android](https://github.com/Lukim99/node-kakao-stable/tree/master/v5)（Android 子设备授权 + LOCO 长连接）
- Facebook Messenger：Meta 官方 Facebook Login + Messenger Platform API
- Instagram：Meta 官方 Instagram API with Instagram Login（专业账号）
- TikTok：官方 API for Business / Business Messaging（企业号 OAuth + 私信 Webhook）
- X：官方 OAuth 2.0 PKCE + Direct Messages API（消息增量轮询）
- Snapchat：官方 Public Profile Messaging（仅品牌公共主页 ↔ 创作者合作消息）
- 测试：Vitest（59+ 用例覆盖核心层）
- 日志:pino（控制台 + `userData/logs/omnichat.log`）

## 开发

```bash
npm install
npm run dev        # 启动开发模式（热更新）
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run build      # 生产构建
```

首次启动后点击左侧 WhatsApp 图标 → 手机 WhatsApp「设置 → 已关联的设备 → 关联设备」扫码登录。
登录凭证保存在本机 `userData/channels/whatsapp/auth/`，不会上传任何服务器。

KakaoTalk 首次登录需填写 Kakao 邮箱与密码，并在手机主设备输入客户端展示的 8 位设备验证码。
验证成功后密码会立即从本地配置清除，只保留该账号独立的设备 UUID 与会话令牌；鉴权、节点发现、
消息长连接均遵循账号自己的 SOCKS4/5 或 HTTP(S) CONNECT 代理。

Messenger / Instagram 新增账号后点击“网页授权并连接”，系统浏览器会打开官方登录页。服务器集中配置
Meta 应用凭证一次即可，所有客户均不需要填写 App ID、App Secret 或访问令牌；同一团队换电脑后会自动
恢复已授权账号。服务器部署步骤见 [`docs/meta-integration.md`](../docs/meta-integration.md)。

TikTok 新增账号也使用“网页授权并连接”。客户必须授权企业号，且服务方 TikTok 开发者应用需先获
Business Messaging 权限；客户端不要求客户填写 App ID、Secret 或 Token。部署步骤见
[`docs/tiktok-integration.md`](../docs/tiktok-integration.md)。

X 新增账号后直接网页授权，可读取和回复当前账号私信。Snapchat 新增账号需先授权已获 API 准入的
品牌 Public Profile，再在账号设置填写创作者 Public Profile ID；它不支持普通个人聊天收件箱。
配置见 [`docs/x-snapchat-integration.md`](../docs/x-snapchat-integration.md)。

## 架构

```
src/
├── shared/                  # 主进程/渲染进程共享的类型与纯函数
│   ├── domain.ts            # 统一消息模型（UnifiedMessage / Conversation / ChannelState）
│   ├── settings.ts          # 应用设置类型
│   └── ipc.ts               # IPC 方法名与 OmniApi 接口
├── main/                    # Electron 主进程
│   ├── core/                # 与具体平台无关的核心层
│   │   ├── channel-adapter.ts   # 渠道适配器抽象基类
│   │   ├── channel-manager.ts   # 适配器注册、事件汇聚、发送路由
│   │   ├── message-store.ts     # 存储接口（当前 JSON 实现，可换 SQLite）
│   │   ├── settings-store.ts    # 设置持久化
│   │   ├── proxy.ts             # 按账号代理（socks/http）
│   │   └── logger.ts            # 日志接口（实现在 logging.ts）
│   ├── channels/            # 渠道插件（每个平台一个目录）
│   │   ├── registry.ts      # 插件注册表
│   │   └── whatsapp/        # Baileys 适配器 + 纯函数消息映射(mapper)
│   ├── translation/         # 翻译插件体系
│   │   ├── pipeline.ts      # 收发消息的翻译管道
│   │   ├── registry.ts      # 引擎插件注册表
│   │   └── providers/       # google-free（默认免费）、custom-http（用户自建接口）
│   ├── ipc.ts               # ipcMain.handle 注册
│   └── index.ts             # 装配根：唯一知道所有具体实现的地方
├── preload/                 # contextBridge 白名单桥（window.omni）
└── renderer/                # React UI（含轻量 i18n：zh-CN / en）
```

**扩展方式：**

- 新增聊天平台：在 `channels/<平台>/` 实现 `ChannelAdapter` + `ChannelPlugin`，在 `index.ts` 注册。
- 新增翻译引擎：在 `translation/providers/` 实现 `Translator`，在 `translation/plugins.ts` 注册。
- 新增界面语言：在 `renderer/src/i18n.tsx` 的 `dictionaries` 增加一个字典。

## 自定义翻译接口协议

设置中选择「自定义接口」后，应用会以如下协议调用你的服务：

```
POST <你的URL>
Authorization: Bearer <API Key>   # 配置了才发送
Content-Type: application/json

{ "text": "原文", "target_lang": "zh-CN" }
```

期望响应：`{ "text": "译文", "source_lang": "en" }`（source_lang 可选）。

## 风险声明

WhatsApp 与 KakaoTalk 通道均基于非官方协议实现，平台升级时可能失效，也存在账号限制风险。
请使用专用号码，控制发送频率。商用场景建议评估官方 WhatsApp Business Cloud API。

## 路线图

见 [TODO.md](./TODO.md)。
