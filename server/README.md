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
| `OMNI_TOKENS` | `dev-token` | 同步令牌，逗号分隔，每个 token = 一个租户 |
| `ANTHROPIC_API_KEY` | — | 缺失时 AI 分析接口返回 501 |
| `OMNI_ANALYSIS_MODEL` | `claude-opus-5` | 意向分析模型 |

## 接口

所有 `/api/*` 需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sync` | 批量同步会话+消息（幂等，按 externalId 去重） |
| POST | `/api/media/missing` | 传入 mediaId 列表，返回尚未上传的 |
| PUT | `/api/media/:mediaId` | 上传媒体二进制 |
| GET | `/api/conversations` | 会话列表（分页） |
| GET | `/api/conversations/:id/messages` | 某会话消息 |
| POST | `/api/analyze/conversation/:id` | AI 分析某会话意向 |
| POST | `/api/analyze/contact/:contactId` | AI 分析某客户（跨会话/账号聚合）意向 |

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
