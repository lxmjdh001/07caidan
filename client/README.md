# OmniChat

多平台聚合聊天桌面客户端（Windows / macOS），面向跨境客服场景：
一个收件箱聚合 WhatsApp、Telegram、LINE 等平台的会话，聊天内容双向自动翻译。

**核心架构原则：平台连接跑在客户端本地。** 每个用户用自己的电脑、自己的 IP（或自己配置的代理）
连接聊天平台，避免所有账号从同一服务端 IP 出口导致的批量封号风险。

## 技术栈

- Electron + electron-vite + React 19 + TypeScript（ESM 全家桶）
- WhatsApp：[Baileys v7](https://github.com/WhiskeySockets/Baileys)（WebSocket 直连，无需浏览器）
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

WhatsApp 通道基于非官方协议（Baileys），违反 WhatsApp 服务条款，存在封号风险。
请使用专用号码，控制发送频率。商用场景建议评估官方 WhatsApp Business Cloud API。

## 路线图

见 [TODO.md](./TODO.md)。
