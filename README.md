# OmniChat

多平台聚合聊天 + 双向自动翻译，面向跨境客服场景的一整套系统。前后端分离，三个独立包：

```
ai-chat/
├── client/   桌面客户端（Electron + React 19，Win/Mac）
│             聚合 WhatsApp/Telegram/LINE 会话，双向自动翻译，多账号+代理隔离
├── server/   后台 API 服务（Fastify 5 + Drizzle ORM + SQLite）
│             聊天记录归档、查询、按需 AI 客户意向分析（Claude）
└── admin/    管理后台前端（React 19 + Vite，前后端分离）
              登录 → 客户/会话列表 → 聊天记录查看 → AI 意向分析
```

## 核心架构原则

**平台连接跑在客户端本地。** 每个用户用自己的电脑、自己的 IP（或自定义代理）连接聊天平台，
避免所有账号从同一服务端 IP 出口导致的批量封号；加密设备身份与代理按账号隔离。

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

## 技术栈

| 包 | 技术 |
|---|---|
| client | Electron 43 · electron-vite · React 19 · TypeScript · Baileys v7 · Vitest |
| server | Fastify 5 · Drizzle ORM（SQLite，可迁 Postgres）· Anthropic SDK · node:test |
| admin | React 19 · Vite 7 · TypeScript |

## 风险声明

WhatsApp 等通道基于非官方协议，违反平台服务条款，存在封号风险。使用专用号码、控制频率，
商用场景建议评估官方 API。
