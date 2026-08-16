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

## M5 — 后端（聊天记录归档 + AI 分析，前后端分离）
> 技术栈：**Fastify 5** + **Drizzle ORM**（开发期 SQLite，schema 可平滑迁 PostgreSQL）
> + Anthropic SDK（意向分析，claude-opus-5 结构化输出）。代码在 `server/`。
- [x] 后台服务骨架：Fastify + Drizzle(SQLite) + Bearer token 鉴权（租户隔离）
- [x] 聊天记录归档：/api/sync 批量幂等入库（会话+消息+译文），媒体上传
- [x] 查询接口：会话列表 / 会话消息 / 按客户跨账号聚合
- [x] AI 意向分析：/api/analyze/conversation|contact（按需，结构化输出意向等级/摘要/信号/建议）
- [x] 客户端批量定时同步引擎（SyncClient，秒级水位去重，含译文与媒体）
- [x] 设置页：后台同步开关 / 地址 / 令牌 / 媒体上传
- [x] 端到端验证：桌面 → 后台，会话+消息+译文+contactId 落库
- [ ] 用户注册 / 登录（Better Auth；token 升级为用户/设备体系）
- [ ] 迁移 PostgreSQL（drizzle-kit 迁移，dialect 切换）
- [ ] 套餐与授权：账号数/渠道数/翻译额度/有效期、订阅状态、到期处理
- [ ] 客户端配置云同步（翻译设置、账号配置跨设备漫游）
- [ ] 设备管理（一个订阅限 N 台、远程下线）
- [ ] 翻译额度计量与上报；支付对接（Stripe/支付宝）
- [ ] 管理后台（React）：客户列表、聊天记录查看、意向分析结果、套餐/用量报表
- [ ] 实时/自动打标签（可选升级：新消息触发意向重算）
- [ ] 媒体走对象存储（S3/MinIO）
- [ ] 客户端自动更新（electron-updater）与审计/风控

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
