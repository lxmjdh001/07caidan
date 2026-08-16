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

## M3 — Telegram ✅
- [x] Telegram 适配器（Bot API 长轮询，纯客户端，无需服务器）；收发文本/图片/语音/视频/文件，媒体下载
- [x] Telegram/LINE mapper 纯函数单测
- [x] 账号类型选择器（新增账号选 WhatsApp/Telegram/LINE），凭证类平台填 Token 表单
- [x] 多渠道会话在同一收件箱聚合（核心层零改动，验证插件架构）

## M4 — LINE ✅
- [x] LINE 适配器（Messaging API）：发信客户端直连；收信经后台 Webhook 中转
- [x] 后台 LINE 中转：注册（存 channelSecret）+ Webhook 验签（HMAC）+ 事件队列 + 客户端轮询拉取
- [x] 会话来源标签已支持 telegram/line（品牌色）
- [ ] LINE 生产验证（需真实 LINE 频道凭证 + 公网后台地址）
- [ ] Telegram/LINE 代理支持（undici ProxyAgent）

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
- [x] 管理后台账号密码登录 + **RBAC**（用户/角色/权限：owner/admin/agent/viewer，可直接分配权限点，会话令牌 DB 持久可撤销，密码 scrypt 哈希）
- [ ] 用户注册 / 找回密码 / 多租户开户（面向 SaaS 售卖时）
- [ ] 迁移 PostgreSQL（drizzle-kit 迁移，dialect 切换）
- [ ] 套餐与授权：账号数/渠道数/翻译额度/有效期、订阅状态、到期处理
- [ ] 客户端配置云同步（翻译设置、账号配置跨设备漫游）
- [ ] 设备管理（一个订阅限 N 台、远程下线）
- [ ] 翻译额度计量与上报；支付对接（Stripe/支付宝）
- [x] 管理后台（React + Vite，前后端分离，admin/）：登录、客户/会话列表、聊天记录查看、AI 意向分析
- [ ] 管理后台扩展：套餐/用量报表、公告推送（待用户体系就绪）
- [ ] 实时/自动打标签（可选升级：新消息触发意向重算）
- [ ] 媒体走对象存储（S3/MinIO）
- [ ] 客户端自动更新（electron-updater）与审计/风控

## M8 — 界面主题与多语言（打粉主战场覆盖）
### 主题
- [x] 配色全部令牌化：客户端 39 处 + 管理后台硬编码颜色收敛为 CSS 变量
- [x] 浅色 / 深色 / 跟随系统三态，默认跟随系统；设置页可切换
- [x] 管理后台同样支持深色（跟随系统）
- [ ] 深色下逐组件人工校对（尤其二维码底色必须保持白底，否则扫不出）
### 多语言
- [x] 首次启动按系统语言自动选择界面语言，无匹配回落英语
- [x] 补齐目标市场：日 / 韩 / 繁中 / 越 / 泰 / 马来 / 印尼 / 西 / 葡(巴) / 阿拉伯
- [x] 字典按语言拆文件（locales/<code>.ts）
- [x] 语言元数据带书写方向与母语自称
- [ ] 管理后台的多语言（目前仍为硬编码中文）
### 书写方向（RTL）
- [x] 阿拉伯语根节点设 dir，整体布局镜像
- [x] CSS 改用逻辑属性（margin-inline-start / text-align: start 等）
- [ ] RTL 下气泡收发方向与时间戳位置的人工校对

## M7 — 白牌定制（贴牌打包）
> 目标：同一份代码，构建时指定一个品牌配置即可产出不同名称/图标的客户端与后台。
> 三端（client / server / admin）**共用同一份配置**，避免改名时漏掉某一端。
- [ ] 品牌配置单一来源：仓库根 `branding/<brand>.json`（appName、shortName、logo/icon 路径、
      主题色、公司名、官网、支持邮箱、协议链接），默认 `branding/default.json`
- [ ] 构建时选择品牌：`BRAND=acme npm run build`，三端各自读取同一份 JSON
- [ ] 客户端：窗口标题 / 关于页 / 托盘名 / 安装包名与图标（electron-builder productName、
      icon、appId 从品牌配置注入），登录页 logo
- [ ] 管理后台（admin/）：登录页与侧边栏 logo + 名称、浏览器标题、favicon、主题色
- [ ] 后端：公开看板页（`/c/:token`）的名称与 logo、邮件模板署名与发件人显示名
- [ ] logo 资源按品牌目录存放（`branding/<brand>/logo.svg`、`icon.icns`、`icon.ico`、`favicon`），
      构建脚本按需拷贝，缺失时回落到默认并给出告警
- [ ] 校验：CI 里对每个品牌跑一次构建，防止某端漏读配置导致上线才发现还叫旧名字

## M9 — 引流工单（已完成主体）
- [x] 工单数据模型 + 分享链接（多条、可设有效期 / 永不过期 / 手动停用）
- [x] 判重：重粉库命中 ∪ 指定时间之前出现过；时间规则可指定参考账号
      （参考账号可以是未参与本工单的老号）
- [x] 重粉库：从历史导出 + 外部名单导入（脏格式自动归一化并回报问题行）
- [x] 公开看板 /c/:token，只含聚合数字，单测钉死不泄露客户身份与聊天内容
- [x] 客户端整页管理界面（建工单 / 配判重 / 管链接 / 管重粉库）
- [x] 管理后台工单视图（只读统计 + 管分享链接 + 管重粉库）
- [x] SQLite 增量迁移（老库自动补列）
- [ ] 工单统计缓存（当前每次现算；账号与消息量大后需要 TTL 缓存）
- [ ] 看板按天趋势的时区随工单配置（已存 tzOffsetMinutes，前端已用，待真实跨时区验证）

## M10 — 投放归因
- [x] WhatsApp Click-to-WhatsApp 广告上下文（ctwaClid / sourceId / sourceUrl）
- [x] 三平台通用 [ref:xxx] 追踪码（入口链接预填文案）
- [x] 会话头部展示来源标签；首条入站消息识别一次后不再覆盖
- [ ] 工单统计按来源拆分（把 leadSource 同步到后台并加入统计维度）
- [ ] 客户端提供「生成带追踪码的入口链接」界面（目前只有函数，没有 UI）

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
