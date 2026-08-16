# OmniChat 开发路线图

> 产品定位：多平台聚合聊天桌面客户端（Win/Mac），双向自动翻译，面向跨境客服场景。
> 核心架构约束：**平台连接跑在客户端本地**（用户自己的 IP，避免服务端集中连接导致批量封号）；
> 必须走服务器的部分（LINE Webhook 等）由轻量中转服务转发到客户端。

## M1 — WhatsApp MVP（当前阶段）
- [x] 项目骨架：Electron + electron-vite + React 19 + TypeScript + Vitest
- [x] 统一消息模型（UnifiedMessage / Conversation / ChannelState）
- [x] 渠道适配器抽象 + **渠道插件注册表**（新平台 = 新插件模块，核心层零改动）
- [x] 存储抽象（MessageStore）+ JSON 文件实现（后续可换 SQLite）
- [x] 翻译管道 + **翻译引擎插件注册表**（默认免费 google-free；支持用户自定义 HTTP 接口）
- [x] 日志模块（pino，文件 + 控制台，核心层仅依赖 Logger 接口）
- [x] **按账号代理**（socks5/socks4/http/https，留空走默认网络，重连生效）
- [x] WhatsApp 适配器（Baileys v7，本地扫码登录、断线重连指数退避、收发文本、识别媒体类型）
- [x] 渲染层 UI：渠道栏 / 会话列表 / 聊天窗 / 扫码页 / 设置弹窗（React，现代浅色风格）
- [x] **界面多语言 i18n**（zh-CN / en，设置页可切换）
- [x] 核心模块单元测试（59 用例：mapper / store / manager / translation / settings / proxy）
- [x] 媒体消息：接收自动下载展示（图片/视频/语音/贴纸/文件，>100MB 跳过）+ 发送本地文件
- [ ] 语音条录制发送（麦克风录音 → ogg/opus ptt 格式）
- [ ] **交付用户测试：扫码登录 → 收发消息（文本 + 媒体）**

## M2 — 翻译完善
- [x] 免费默认引擎（google-free，无需 Key）
- [x] 自定义翻译接口（用户自建 HTTP 端点 + 可选 API Key，协议见 README）
- [x] 翻译引擎插件：DeepL / Google Cloud 官方 / LLM（OpenAI 兼容）
- [x] 出站自动翻译：目标语言四级解析（会话手动 > 自动检测 > 账号默认 > 全局默认 en）
- [x] 客户语言自动检测（入站翻译时源语言识别，写入会话）
- [x] 会话设置弹层（聊天窗右上角）：手动指定客户语言
- [x] 出站气泡双显（发出的译文 + 坐席原文）
- [ ] 出站翻译预览确认交互（输入 → 显示译文 → 确认发送，可设免确认）

## M3 — Telegram
- [ ] Telegram 适配器（Bot API long-polling，可完全跑在客户端，无需服务器）
- [ ] 多渠道会话在同一收件箱聚合验证（架构验收点：不改核心层代码）

## M4 — LINE
- [ ] LINE 适配器（Messaging API）
- [ ] ⚠️ LINE 只支持公网 Webhook 收消息，无法纯客户端 —— 需要一个轻量中转服务
      （服务器只做 Webhook→WebSocket 转发，不存消息，发送仍从客户端直连 LINE API）
- [ ] 中转服务的部署脚本与鉴权

## M5 — 后端（用户/套餐管理，前后端分离）
> 技术栈（2026 调研结论）：**Fastify**（轻量高性能 + JSON Schema 校验 + OpenAPI 生成）
> + **Drizzle ORM + PostgreSQL** + **Better Auth**（TS 原生认证，自带组织/RBAC 插件）。
> 管理后台独立 React + Vite 前端；同一套 REST API 供 Electron 客户端调用。
- [ ] 独立仓库/工作区 `omnichat-server`：Fastify + Drizzle + PostgreSQL 骨架
- [ ] 用户注册 / 登录（邮箱+密码，Better Auth；客户端登录后才可使用）
- [ ] 套餐与授权：套餐定义（账号数/渠道数/翻译额度/有效期）、订阅状态、到期处理
- [ ] 客户端配置云同步（翻译设置、账号配置跨设备漫游）
- [ ] 设备管理（一个订阅限 N 台设备、远程下线）
- [ ] 翻译额度计量与上报（免费引擎不计、自有引擎按字符计）
- [ ] 支付对接（Stripe / 支付宝等，按目标市场定）
- [ ] 管理后台（React）：客户列表、套餐管理、用量报表、公告推送
- [ ] 客户端自动更新通道与灰度发布
- [ ] 审计日志与基础风控（异常登录、共享账号检测）

## M6 — 产品化
- [ ] WhatsApp 多账号支持（模型已预留 accountId，UI 与生命周期管理待做）
- [ ] 媒体消息收发（图片/语音/文件的下载展示与发送）
- [ ] 存储替换为 SQLite（消息量大时的性能；MessageStore 接口不变）
- [ ] electron-builder 打包：Mac 签名/公证、Win 安装包、自动更新（electron-updater）
- [ ] 关机期间消息：评估"云端托管会话"付费选项（适配器已设计为客户端/服务端同构可跑）
- [ ] Facebook Messenger / Instagram 渠道（官方 Graph API，需提前启动 Meta App Review，周期约 1-2 个月）

## 长期注意事项
- WhatsApp 非官方通道有封号风险：产品内保留官方 Cloud API 双通道选项与风险提示
- Baileys 跟随 WhatsApp 协议变动较频繁，锁版本 + 升级前跑全量测试
- 消息去重依赖 externalId（断线重连会补发历史）
