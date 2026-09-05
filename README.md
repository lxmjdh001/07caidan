# WzzScrm

多平台聚合聊天 + 双向自动翻译，面向跨境客服场景的一整套系统。前后端分离，三个独立包：

```
07caidan/
├── client/   桌面客户端（Electron + React 19，Win/Mac）
│             聚合 WhatsApp/Telegram/LINE/KakaoTalk/Messenger/Instagram/TikTok/X/Snapchat，会话双向翻译
├── server/   后台 API 服务（Fastify 5 + Drizzle ORM + SQLite）
│             聊天记录归档、查询、按需 AI 客户意向分析（Claude）
└── admin/    管理后台前端（React 19 + Vite，前后端分离）
              登录 → 客户/会话列表 → 聊天记录查看 → AI 意向分析
```

## 核心架构原则

WhatsApp、Telegram、LINE、KakaoTalk 的个人账号连接跑在客户端本地，并按账号隔离设备身份与代理。
Facebook Messenger 与 Instagram 采用 Meta 官方 OAuth + Graph API：应用凭证和加密访问令牌只在服务器，
客户只需在官方网页授权，桌面端不会接触 App Secret 或 Page/Instagram Token。
TikTok 采用官方 API for Business：企业号网页授权、自动续期、私信 Webhook 与消息 API 都由服务器托管，
access/refresh token 加密入主库，换电脑后自动恢复账号与历史。
X 采用官方 OAuth 2.0 PKCE 与 Direct Messages API；Snapchat 采用官方 Public Profile Messaging，
仅支持获准入品牌公共主页与创作者之间的合作消息，两者的令牌和会话同样保存在服务器主库。

聊天记录由客户端**批量定时同步**到后台（含译文、可选媒体），后台按客户唯一标识（手机号）
跨账号聚合，供查询与按需 AI 意向分析。

## 快速开始

```bash
# 1. 后台 API（必填同步令牌；选填 AI 分析用的 Anthropic Key）
cd server && npm install
OMNI_TOKENS=your-token ANTHROPIC_API_KEY=sk-... npm start   # :8787

# 2. 桌面客户端
cd client && npm install && npm run dev

# 3. 管理后台
cd admin && npm install && npm run dev                       # :5180
```

客户端设置里填后台地址与令牌开启同步；管理后台用同一地址+令牌登录。

## 各包详情

- 客户端：见 [client/README.md](./client/README.md)
- 后台服务：见 [server/README.md](./server/README.md)
- 路线图：见 [TODO.md](./TODO.md)
- Meta Messenger / Instagram 部署：见 [docs/meta-integration.md](./docs/meta-integration.md)
- TikTok Business Messaging 部署：见 [docs/tiktok-integration.md](./docs/tiktok-integration.md)
- X / Snapchat 部署与能力边界：见 [docs/x-snapchat-integration.md](./docs/x-snapchat-integration.md)
- GitHub 与生产部署：见 [deploy/README.md](./deploy/README.md)

## 技术栈

| 包 | 技术 |
|---|---|
| client | Electron 43 · electron-vite · React 19 · TypeScript · Baileys v7 · Vitest |
| server | Fastify 5 · Drizzle ORM（SQLite，可迁 Postgres）· Anthropic SDK · node:test |
| admin | React 19 · Vite 7 · TypeScript |

## 风险声明

WhatsApp 与 KakaoTalk 通道基于非官方协议，存在兼容性与账号限制风险。Messenger、Instagram、
TikTok、X 与 Snapchat 使用官方接口，但必须通过对应平台的应用审核、付费层级和账号资格检查。
