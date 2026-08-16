# OmniChat Server

聊天记录归档后台：接收桌面客户端批量同步的会话/消息（含译文、可选媒体），
提供查询接口，并支持按需的 AI 客户意向分析（Claude）。

## 技术栈

- Fastify 5 + Node 内置 `node:sqlite`（零原生依赖）
- Anthropic SDK（意向分析，默认 `claude-opus-5`，结构化输出）
- 鉴权：Bearer token（第一版，token 即租户标识；后续接 Better Auth 用户体系）

## 运行

```bash
npm install
# 必填：同步令牌（多个逗号分隔）；选填：AI 分析用的 Key
OMNI_TOKENS=your-token ANTHROPIC_API_KEY=sk-... npm start
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | 8787 / 0.0.0.0 | 监听地址 |
| `OMNI_DATA_DIR` | `./data` | 数据目录（db + 媒体） |
| `OMNI_TOKENS` | `dev-token` | **同步客户端**令牌，逗号分隔，每个 = 一个租户 |
| `OMNI_ADMIN_USER` / `OMNI_ADMIN_PASSWORD` | admin / admin | 首次启动创建的 owner 账号（管理后台登录） |
| `OMNI_ADMIN_TENANT` | 第一个同步令牌 | 管理员可见的租户 |
| `ANTHROPIC_API_KEY` | — | 缺失时 AI 分析接口返回 501 |
| `OMNI_ANALYSIS_MODEL` | `claude-opus-5` | 意向分析模型 |

## 认证与 RBAC

两类主体，同一 `Authorization: Bearer <token>` 头：
- **同步客户端**：`OMNI_TOKENS` 里的令牌，只能调 `/api/sync`、`/api/media/*`
- **管理后台用户**：账号密码登录换取会话令牌，按权限访问。角色预设 + 可直接分配的权限。

权限点：`conversations:read`（看聊天记录）、`analyze:run`（AI 分析）、`users:manage`（用户管理）。
角色预设：`owner`（全部）、`admin`、`agent`（读+分析）、`viewer`（只读）。

## 接口

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/login` | 公开（账号密码换令牌） |
| GET | `/api/me` | 登录用户 |
| POST | `/api/logout` | 登录用户 |
| GET | `/api/meta/permissions` | users:manage（权限/角色元数据） |
| GET/POST | `/api/users` | users:manage（列表/新建） |
| PATCH/DELETE | `/api/users/:id` | users:manage（改角色/权限/启停/删） |
| POST | `/api/sync` | 同步令牌 |
| POST | `/api/media/missing` · PUT `/api/media/:id` | 同步令牌 |
| GET | `/api/conversations` · `/api/conversations/:id/messages` | conversations:read |
| POST | `/api/analyze/conversation/:id` · `/api/analyze/contact/:contactId` | analyze:run |

意向分析返回：`{ intentLevel, summary, signals[], suggestedAction }`。

## 数据模型

- `conversations` (tenant, id) — 会话，含 `contact_id`（客户唯一标识，跨账号）
- `messages` (tenant, external_id) — 消息，含译文与媒体引用
- `media` (tenant, media_id) — 媒体文件登记

按 `contact_id` 可跨账号/渠道聚合同一客户的全部对话，供 AI 分析意向。

## 测试

```bash
npm test   # node:test，覆盖 Repo 幂等/租户隔离/跨会话聚合
```

## 待办（生产化）

- 用户注册/登录/套餐（Better Auth + 迁移到 PostgreSQL）
- 每租户配额与用量计量
- 媒体走对象存储（S3/MinIO）
