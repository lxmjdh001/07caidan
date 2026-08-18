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
- [x] 语音条录制发送（MediaRecorder webm/opus，WA 侧带 ptt 标记；
      ⚠️ iOS 端 WhatsApp 对 webm 兼容性存疑，标准 ogg 转封装需 ffmpeg，见下）
- [ ] 语音发送格式升级：接入 ffmpeg（或 wasm 版）把 webm 转 ogg/opus，
      确保 iOS WhatsApp / Telegram 语音条完全兼容
- [x] 收到的语音消息一键「转文字」（走后台 ASR 按积分计费，结果缓存在消息上，
      同一条语音只计费一次）
- [x] 交付用户测试：扫码登录 → 收发消息（文本 + 媒体）

## M2 — 翻译完善
- [x] 免费默认引擎（google-free，无需 Key）
- [x] 自定义翻译接口（用户自建 HTTP 端点 + 可选 API Key，协议见 README）
- [x] 翻译引擎插件：DeepL / Google Cloud 官方 / LLM（OpenAI 兼容）
- [x] 出站自动翻译：目标语言四级解析（会话手动 > 自动检测 > 账号默认 > 全局默认 en）
- [x] 客户语言自动检测（入站翻译时源语言识别，写入会话）
- [x] 会话设置弹层（聊天窗右上角）：手动指定客户语言
- [x] 出站气泡双显（发出的译文 + 坐席原文）
- [x] 出站翻译预览确认交互（输入 → 显示译文 → 确认发送，可设免确认）

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
- [x] Telegram(Bot)/LINE 代理支持（undici Dispatcher：http/https 用 ProxyAgent，socks4/5 用自建 Agent + socks 拨号）；SOCKS5 真实回路集成测试。telegram-user(GramJS) 与 WhatsApp(Baileys) 本就有原生代理

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
- [x] 用户注册 + 找回密码（邮箱验证码，防探测、旧会话全吊销）；多租户开户未做
- [ ] 迁移 PostgreSQL（drizzle-kit 迁移，dialect 切换）
- [x] 套餐与授权（并入 M11：账号数上限/周期/订阅状态/到期处理均已完成）
- [x] 客户端配置云同步（偏好跨设备漫游）
      服务端 client_configs 表 + ClientConfigRepo（后写为准）+ GET/PUT /api/client/settings；
      客户端 ConfigSync：登录/启动 pull、偏好变更防抖 push；白名单只搬非敏感偏好
      （语言/主题/翻译偏好/通知/自动回复话术）。**安全红线**：平台凭证/会话/代理、登录令牌、
      各引擎 apiKey、telegramApiHash 一律不上云（pickSyncable 单测钉死不泄露）。设置页「云端漫游」开关。
      测试：客户端 5 条（白名单/合并/往返）+ 服务端 7 条（LWW/隔离）；e2e 截图开关默认开。
      注：「账号配置漫游」按安全设计不含凭证 —— 平台会话本就与设备绑定，换设备需各自登录
- [x] 设备管理（一个订阅限 N 台、远程下线）
      服务端：会话记设备指纹 + 套餐 max_devices + 登录判重（老板与子账号共享设备池，
      已在册设备不占名额、超限返 403+设备列表）+ listDevices/revokeDevice（跨老板隔离）+
      GET/POST /api/client/devices*；后台计费页「设备上限」列；
      客户端登录/注册上报 deviceId；客户端「团队管理 → 登录设备」查看 + 远程下线（本机禁下线）。
      验收：8 条服务端单测；Playwright 后台交互用例（建带设备上限套餐）+ 真 Electron 客户端 e2e
      （注册→团队管理→登录设备截图）。遗留小项：超限登录页内联下线（当前给出明确错误提示引导）
- [x] 额度计量与支付对接（并入 M11/M12：易支付/PayPal/USDT + 模型积分；Stripe 未做）
- [x] 管理后台（React + Vite，前后端分离，admin/）：登录、客户/会话列表、聊天记录查看、AI 意向分析
- [x] 管理后台套餐/用量报表（计费管理五页签）；公告推送未做
- [x] 实时/自动打标签（新消息触发意向重算）
      conversation_intent 表 + IntentRepo（落库/批量取/needsRetag 节流）+ AutoTagger（sync 后对
      有新入站的会话非阻塞打标签，maxPerRun 上限）+ StubAnalyzer（关键词零成本，无 key 也能自动打）。
      开关 OMNI_AUTO_TAG；Claude 按需深度分析结果也落库覆盖关键词标签。
      会话列表附加 intentLevel，后台聊天记录列表显示高/中/低意向彩色标签，
      并支持按意向筛选（全部/高/中/低），老板一键聚焦高意向线索。
      后台意向面板打开会话即展示已落库分析（等级/摘要/信号/建议/上次分析时间），无需点分析、无需 key；
      GET /api/conversations/:id/intent；「分析该会话」按钮仍走 Claude 深度分析并覆盖。
      客户端聊天头部本地关键词意向标签（localIntent，纯前端零成本，高/中提示）——让接待的客服
      也一眼看出当前客户购买意向，5 语已加标签文案。
      测试：11 条服务端 + 5 条客户端(localIntent)；e2e 截图（后台列表标签/意向筛选/面板/客户端头部标签）
- [ ] 媒体走对象存储（S3/MinIO）
- [ ] 客户端自动更新（electron-updater）与审计/风控

## M8 — 界面主题与多语言（打粉主战场覆盖）
### 主题
- [x] 配色全部令牌化：客户端 39 处 + 管理后台硬编码颜色收敛为 CSS 变量
- [x] 浅色 / 深色 / 跟随系统三态，默认跟随系统；设置页可切换
- [x] 管理后台同样支持深色（跟随系统）
- [x] 深色下逐组件人工校对（尤其二维码底色必须保持白底，否则扫不出）
      Playwright 截图核对：后台 7 页（colorScheme:dark）+ 客户端团队/登录设备页（Electron emulateMedia dark）
      均无对比度问题；二维码用 qrcode 默认色（黑模块+不透明白底，白底烘焙进 PNG），
      深色主题下仍是白底黑码，可正常扫描 —— 风险点已天然规避，无需改代码
### 多语言
- [x] 首次启动按系统语言自动选择界面语言，无匹配回落英语
- [~] 补齐目标市场：日✅ / 韩✅ / 繁中✅ / 越 / 泰 / 马来 / 印尼 / 西 / 葡(巴) / 阿拉伯
      进度：**繁中 + 日本語 + 한국어 均已 100% 补齐**（连同简中/英，共 5 语全量可用）。
      - 繁中（台湾/香港）+207 键；日本語 +207 键；한국어 +207 键（各含 campaign/billing/team/
        settings/support/device 全部功能），均 e2e 截图确认无英文回落。
      其余 5 语（越/泰/马来/印尼/西/葡(巴)/阿拉伯）仍缺 ~185 键，逐语言补齐、建议母语校对
- [x] 字典按语言拆文件（locales/<code>.ts）
- [x] 语言元数据带书写方向与母语自称
- [x] 管理后台多语言（中/英，按系统语言自动选，侧栏可切换并记住选择）
### 书写方向（RTL）
- [x] 阿拉伯语根节点设 dir，整体布局镜像
- [x] CSS 改用逻辑属性（margin-inline-start / text-align: start 等）
- [x] RTL 下气泡收发方向与时间戳位置的人工校对
      阿拉伯语 Electron 截图核对（预置阿语会话）：整体镜像正确 —— 入站气泡靠右、出站靠左、
      时间戳与 ✓ 回执随之镜像。修复气泡尾角与 meta 对齐用物理属性的问题（border-bottom-*-radius
      → border-end-*-radius；text-align:right → end），尾角现随方向镜像。
      旁注（另立）：阿语字典缺若干导航键（Plan & Balance / Team / Help & Feedback 回落英文），
      属多语言补全，非 RTL 布局问题

## M11 — 计费、套餐与支付
> 客户端「套餐与余额」页已完成（概览/套餐/充值/账单四页签）。
> 定时任务已完成：5 分钟巡检到期订阅（自动续费/过期）与超时订单，
> 启动时立即补跑一次，巡检幂等。
> 管理后台计费界面已完成（套餐/通道/汇率/AI 模型/用量报表五个页签）。
> HTTP 路由已完成：管理配置 / 客户端下单订阅 / 公开支付回调，
> 含 mock 通道全链路测试（下单→回调→到账→订阅→积分扣费）。
> 金额一律以**美元**为基准单位存储与结算；展示时按管理员配置的汇率换算成本地货币。
> 钱相关的计算全部放纯函数并单测钉死 —— 折算算错就是直接的资损/客诉。
### 套餐
- [x] 套餐模型（价格/账号数上限/月季半年年/自定义天数）
- [x] 套餐订阅（生效/到期/状态）
- [x] 自动续费开关；余额不足标记过期（不产生欠费中间态）
- [x] 升级/降级按时间折算，多退少补（退款向下取整、收费向上取整）
- [x] 账号数超限只禁新增、不强制踢下线
### 余额
- [x] 用户余额（USD 整数分存储）
- [x] 全量流水账 + auditBalance 对账校验
- [x] 余额不足的行为：整笔失败，绝不透支
### 支付通道
- [x] 易支付（MD5 签名 + 异步回调，签名与验签纯函数化并单测）
- [x] USDT（收款地址 + 金额唯一化匹配 + 确认数门槛）
- [x] PayPal（Orders v2 建单载荷 + Webhook 事件解析；验签必须由调用方先完成）
- [x] 每个通道可配置手续费率与固定费
- [x] 手续费可设为由客户承担，下单时加进应付金额（gross-up）
- [x] 汇率表 + 下单锁定汇率（字符串存储，避免浮点往返失真）
- [x] 回调幂等（状态条件更新，重复回调只入账一次）

## M12 — AI 接口与模型积分
> 全部完成：管理后台配置界面、真实调用 HTTP 客户端（/api/ai/translate + /api/ai/asr，
> 密钥不出后台）、客户端 ai-server 翻译引擎与「402/501 冷却回落免费引擎」降级链路。
> 模型用途：客户端语音消息识别、收发文字翻译、后续 AI 自动回复。
- [x] AI 供应商数据层：OpenAI / Anthropic / OpenRouter / OpenAI 兼容四类协议，
      支持自定义 baseUrl；API Key 出接口一律打码
- [x] 每个供应商下多模型，各自设定输入/输出/语音的积分单价与最低消费
- [x] 按 token 消耗扣积分；用量流水 + 按模型/用途分组汇总
- [x] 积分自动从余额补足（可开关）+ 兑换比例可配
- [x] 用途区分 asr / translate / autoreply，模型按用途筛选
- [x] 降级策略：402/501 时客户端冷却 5 分钟并回落免费引擎，网络故障单次回落
- [x] 全部测试脱离网络：协议构造/解析是纯函数，计费直接喂预设 token 数

## M7 — 白牌定制（贴牌打包）
> 目标：同一份代码，构建时指定一个品牌配置即可产出不同名称/图标的客户端与后台。
> 三端（client / server / admin）**共用同一份配置**，避免改名时漏掉某一端。
- [x] 品牌配置单一来源：仓库根 branding/<brand>.json，默认 default.json
- [x] BRAND=<name> 选择品牌：client/admin 构建期注入，server 运行时读取；
      打错品牌名硬失败，不悄悄回落默认
- [x] 客户端：窗口标题/标题栏/登录 Logo/通知兜底标题/app 名；
      各品牌独立 userData 目录（贴牌版与原版共存不串数据）
- [x] electron-builder 打包接入：productName/appId/输出目录/NSIS 快捷方式名
      随品牌走；品牌图标目录存在时自动使用；无证书时跳过签名自动发现
- [x] 管理后台：登录页标题、侧栏 Logo/名称、浏览器标题、主题色接入强调色、按品牌 favicon
- [x] 后端：看板页标题占位符替换、验证码邮件署名（logo 预留）
- [~] logo 资源按品牌目录存放（`branding/<brand>/logo.svg`、`icon.icns`、`icon.ico`、`favicon`），
      构建脚本按需拷贝，缺失时回落到默认并给出告警
      已有：electron-builder 按 `branding/<brand>/icon.*` 存在与否选用，缺失回落默认并在构建日志提示。
      themeColor 已接入 UI 强调色 + Logo 徽标渐变（客户端+后台运行时把 --accent/--accent-soft/
      --brand-logo 染成品牌色，仅自定义品牌覆盖，默认绿保持浅/深调优值）。
      后台 favicon 已按品牌运行时生成（SVG data-URI：品牌色底 + logoText，总是注入）。
      e2e 确认紫色品牌整机强调色+Logo 变紫、favicon 断言注入。
      待办（可选）：客户端渲染层用真实 logo.svg 图片替代文字徽标
- [x] 校验：CI 对每个品牌校验配置，防止某端漏读配置导致上线才发现还叫旧名字
      `scripts/verify-brands.mjs`（`npm run verify:brands`）+ `scripts/brand-schema.mjs`：
      校验 branding/*.json 的所有端所需字段并集（appName/shortName/logoText/company/dashboardTitle/
      apiUrl/themeColor 必填非空 + 格式；未知字段=拼写错误也挡下）。8 条单测锁定规则。
      比"每个品牌全量构建"更快，且精准抓住"旧名字/漏读配置/apiUrl 空连不上后台"这类上线事故

## M9 — 引流工单（已完成主体）
- [x] 工单数据模型 + 分享链接（多条、可设有效期 / 永不过期 / 手动停用）
- [x] 判重：重粉库命中 ∪ 指定时间之前出现过；时间规则可指定参考账号
      （参考账号可以是未参与本工单的老号）
- [x] 重粉库：从历史导出 + 外部名单导入（脏格式自动归一化并回报问题行）
- [x] 公开看板 /c/:token，只含聚合数字，单测钉死不泄露客户身份与聊天内容
- [x] 客户端整页管理界面（建工单 / 配判重 / 管链接 / 管重粉库）
- [x] 管理后台工单视图（只读统计 + 管分享链接 + 管重粉库）
- [x] SQLite 增量迁移（老库自动补列）
- [x] 工单统计缓存（30s TTL 内存缓存，key=tenant:campaignId:updatedAt —— 改工单即换 key 自动失效；
      传自定义 labels 的调用绕过缓存；invalidateStats 可强制清空。5 条单测钉死命中/过期/失效/绕过/清空。
      公开看板与老板端共用此缓存，抗高频刷新。后台工单统计页 e2e 截图核对真实数字）
- [x] 看板按天趋势的时区随工单配置（跨时区已验证）
      dayKey/fillDays 按工单 tzOffsetMinutes 归日；补测负偏移（UTC 以西）：同一绝对窗口
      纽约(UTC-5)归 08-16、北京(UTC+8)归 08-17，边界/跨月正确。公开看板 /c/:token e2e 截图
      核对聚合卡+每日趋势渲染，并断言页面不含任何粉丝身份（红线保持）

## M10 — 投放归因
- [x] WhatsApp Click-to-WhatsApp 广告上下文（ctwaClid / sourceId / sourceUrl）
- [x] 三平台通用 [ref:xxx] 追踪码（入口链接预填文案）
- [x] 会话头部展示来源标签；首条入站消息识别一次后不再覆盖
- [x] 工单统计按来源拆分（leadSource 随同步上传，统计新增 bySource 维度，
      客户端 / 管理后台 / 公开看板三处都已展示）
- [x] 客户端「推广链接」页签：选账号 → 填追踪码 → 实时预览并复制入口链接；
      账号手机号/用户名登录后自动带出（LINE 需手填官方账号 ID）

## M6 — 产品化
- [x] WhatsApp 多账号支持（账号列表/按账号代理与指纹/生命周期）
- [x] 媒体消息收发（图片/视频/语音/文件，微信风格语音条）
- [ ] 存储替换为 SQLite（消息量大时的性能；MessageStore 接口不变）
- [x] electron-builder 打包配置（dmg 双架构 / NSIS / AppImage；dist 与 dist:dir 脚本）
- [ ] Mac 签名与公证（需开发者证书，发布流水线配 CSC_LINK）
- [ ] 自动更新（electron-updater）
- [ ] 关机期间消息：评估"云端托管会话"付费选项（适配器已设计为客户端/服务端同构可跑）
- [ ] Facebook Messenger / Instagram 渠道（官方 Graph API，需提前启动 Meta App Review，周期约 1-2 个月）

## M13 — AI 自动回复（已完成主体）
- [x] 后端 /api/ai/reply：带上下文对话补全，按 autoreply 用途计费，
      system 由客户端传入（话术完全由使用者控制），非法角色过滤防注入
- [x] 客户端 AutoReplyService：两层开关（全局 + 会话）、仅入站私聊、
      冷却间隔（防机器人互怼烧积分）、并发防双回复、失败不影响收消息
- [x] 上下文构造：最多 12 条，语音优先用转写文本（能"听懂"语音）、
      媒体用占位符；最后一条非客户消息不抢话
- [x] 回复走 prepared 跳过出站翻译（模型已按客户语言作答）
- [x] 设置页话术/间隔配置 + 会话设置里的单会话开关
- [x] 自动回复的可视标识（AI 气泡角标，origin 字段随消息入库）
- [x] 转人工规则：关键词命中（含语音转写）→ 停用该会话自动回复 +
      系统通知提醒接管；优先于冷却判断

## M14 — LINE 千账号规模优化（已完成主体）
- [x] 后台 /api/line/pull-all：一次拉取整租户全部账号的事件并按账号分组
- [x] 客户端 LinePollCoordinator：整机单例定时器，所有 LINE 账号共享，
      请求量与账号数解耦（1000 账号从 200 req/s 降至 0.2 req/s）
- [x] 单账号处理异常不影响其它账号分发；全部注销后定时器自动停止
- [x] 事件队列超龄清理 pruneStale（3 天没人拉的事件丢弃，防离线堆积）
- [x] pruneStale 每小时执行一次（随服务启停）
- [ ] 进一步升级为长轮询/SSE（当前 5 秒轮询延迟对客服场景可接受）

## M16 — 托盘 / 版本与升级
- [x] 托盘图标（base64 内嵌防打包丢失；mac 模板图适配深浅菜单栏）+
      菜单：打开主界面(带未读数)/检查更新/版本号/退出
- [x] 关窗进托盘保持在线收消息；tooltip 显示未读；托盘退出才真退出
- [x] 新消息系统通知（此前已完成：未聚焦弹通知/点击直达/可关预览/角标）
- [x] electron-updater：自家后台 generic 源，启动+每4小时检查，静默下载，
      退出自动安装；开发模式自动禁用；更新失败不影响主功能
- [x] 后台 /updates 静态分发（文件名白名单防穿越，流式返回大安装包）
- [x] 设置页「关于」：版本号/检查更新/下载进度/就绪提示与立即重启按钮

## M18 — 支持工单（软件使用问题，区别于打粉的引流工单）
- [x] 表与状态机：open↔replied→closed；closed 后用户回复自动重开
- [x] 客户端「帮助与反馈」页：提交（可贴图）/查看/追问/关闭
- [x] 后台「支持工单」页（open 置顶、状态圆点、图文回复）+ support:manage 权限
- [x] 贴图走 media 通道；新增带鉴权的媒体下载路由（img 转对象 URL 展示）

## M20 — Crisp 在线客服 ✅
- [x] 独立 BrowserWindow + 本地生成 HTML 挂官方 widget（sandbox，无 Node 能力；
      不进主窗口，避开 CSP 与遮挡）
- [x] Website ID 由后台 /api/client/config 下发（OMNI_CRISP_WEBSITE_ID）；
      未配置则帮助页不显示「在线客服」入口
- [x] session:data 注入：套餐名/到期日/余额/软件版本/系统/设备指纹/角色 +
      user:email；账单信息尽力而为（客服子账号无 billing:manage 时跳过）
- [x] Website ID 格式校验 + JSON 序列化防脚本注入；单测覆盖


## M21 — 客户端 RBAC（老板/客服分权，子账号模型）✅
> 核心原则：**界面隐藏只是体验，服务端校验才是安全**。
> 定案：客服是老板的**子账号**（ownerId），不是同级用户 ——
> 套餐/余额/积分消耗一律记在老板头上（billingUserId = ownerId ?? 自己）。
- [x] clientUsers 加 ownerId/role/permissions/enabled + client_roles 表（含增量迁移）
- [x] 客户端权限点：campaigns:manage / billing:manage / accounts:manage /
      settings:manage / team:manage；聊天为基础能力人人可用
- [x] 预设：boss（全部）/ agent（仅聊天）；自助注册即 boss
- [x] 角色由老板在客户端「团队管理」创建：委派 ⊆ 校验（不能分配超出自己
      的权限）；不允许建同级 boss；在用角色不可删
- [x] 子账号生命周期：停用/改密即吊销会话；停用后不能登录
- [x] 登录响应携带 role+permissions；/api/me/permissions 启动刷新
- [x] 服务端强制：工单/重粉库需 campaigns:manage；钱包/订单/订阅需
      billing:manage；AI 运行时（翻译/ASR/自动回复）客服可用、扣老板积分
- [x] 客户端：底部导航/设置页签/添加账号/账号齿轮按权限显隐；团队管理页
      （成员建停改密 + 自定义角色勾选权限）
- [x] 测试：15 条 HTTP 集成测试（委派收敛/会话吊销/跨老板隔离/静态令牌兼容）

## M19 — 客户端日志上报 ✅
- [x] 硬件派生设备指纹（hostname/平台/架构/CPU/内存/MAC 的 sha256，前 32 位；
      不含隐私原文）
- [x] LogUploader：teeLogger 叠在 pino 之外，warn 起报（门槛可由服务端下发调整）；
      30s/攒 50 条冲刷，失败保留重试，缓冲上限 500 防内存膨胀，退出前补一次冲刷
- [x] POST /api/logs：登录带令牌关联用户；**游客无令牌也可上报**（登录前崩溃
      最需要日志）；带 app 版本/系统类型/系统版本；响应回传目标级别
- [x] 服务端：client_logs + client_log_levels 表；消息/meta 截断；批量上限 200；
      14 天自动清理（并入小时定时器）
- [x] 管理后台「客户端日志」页（support:manage）：设备概览（版本/系统/错误计数）
      + 点击筛选 + 级别过滤（≥level）+ 搜索 + 按用户调级别（默认 warn）
- [x] 测试：8 条 HTTP 集成 + 9 条上传器单测（游客头/重试/门槛下发/缓冲上限）


## M17 — 运营公告与到期提醒
### 公告（管理员 → 定向人群）
- [x] 公告：标题/正文/受众（全部/指定套餐/注册N天内/N天内到期）/启停
- [x] 受众拉取时实时求值
- [x] 已读表；客户端只收未读
- [x] 后台「运营公告」页 + announcements:manage 权限
- [x] 客户端启动+每30分钟拉取，弹窗展示，关闭即标已读
### 到期提醒
- [x] 到期提醒配置：开关/多档天数/邮件开关/模板（5 个变量）
- [x] 模板渲染纯函数（缺变量保留原样）
- [x] 每小时巡检；(用户,档位,到期时间) 去重，只发最小满足档位
- [x] 站内保底 + 邮件可选；与公告同一拉取通道
- [x] 后台设置界面（公告页内含到期提醒配置块）

## 长期注意事项
- WhatsApp 非官方通道有封号风险：产品内保留官方 Cloud API 双通道选项与风险提示
- Baileys 跟随 WhatsApp 协议变动较频繁，锁版本 + 升级前跑全量测试
- 消息去重依赖 externalId（断线重连会补发历史）
