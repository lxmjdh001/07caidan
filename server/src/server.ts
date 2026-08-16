import { createWriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { IntentAnalyzer } from './analyzer.ts'
import type { ServerConfig } from './config.ts'
import { openDb } from './db.ts'
import { Repo } from './repo.ts'
import type { SyncPayload } from './types.ts'

/** 从 Authorization: Bearer <token> 解析租户；token 即租户标识（第一版） */
function tenantFromAuth(auth: string | undefined, tokens: string[]): string | null {
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7).trim()
  return tokens.includes(token) ? token : null
}

export function buildServer(config: ServerConfig): FastifyInstance {
  const db = openDb(config.dbPath)
  const repo = new Repo(db)
  mkdirSync(config.mediaDir, { recursive: true })
  const analyzer = config.anthropicApiKey
    ? new IntentAnalyzer(config.anthropicApiKey, config.analysisModel)
    : null

  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 })
  // 前后端分离：管理后台是独立前端（admin/），这里开放跨域即可
  void app.register(cors, { origin: true })

  // 鉴权：所有 /api 路由需带有效 Bearer token
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return
    const tenant = tenantFromAuth(req.headers.authorization, config.tokens)
    if (!tenant) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    ;(req as { tenant?: string }).tenant = tenant
  })

  const tenantOf = (req: unknown): string => (req as { tenant: string }).tenant

  app.get('/health', async () => ({ ok: true }))

  // 批量同步：客户端定时上传增量
  app.post('/api/sync', async (req) => {
    const payload = req.body as SyncPayload
    const result = repo.ingest(tenantOf(req), {
      conversations: payload.conversations ?? [],
      messages: payload.messages ?? []
    })
    return { ok: true, ...result }
  })

  // 媒体去重探测：客户端上传前先问哪些 mediaId 还没上传
  app.post('/api/media/missing', async (req) => {
    const { mediaIds } = req.body as { mediaIds: string[] }
    const missing = (mediaIds ?? []).filter((id) => !repo.hasMedia(tenantOf(req), id))
    return { missing }
  })

  // 媒体二进制上传（raw body），路径参数为 mediaId
  app.put('/api/media/:mediaId', async (req, reply) => {
    const tenant = tenantOf(req)
    const mediaId = (req.params as { mediaId: string }).mediaId
    if (!/^[\w.-]+$/.test(mediaId)) {
      return reply.code(400).send({ error: 'invalid mediaId' })
    }
    const dir = join(config.mediaDir, tenant)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, mediaId)
    let size = 0
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        cb(null, chunk)
      }
    })
    await pipeline(req.raw, counter, createWriteStream(path))
    repo.recordMedia(tenant, mediaId, (req.headers['content-type'] as string) || null, path, size)
    return { ok: true, size }
  })

  // 查询：会话列表
  app.get('/api/conversations', async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    return {
      conversations: repo.listConversations(
        tenantOf(req),
        Number(q.limit) || 100,
        Number(q.offset) || 0
      )
    }
  })

  // 查询：某会话的消息
  app.get('/api/conversations/:id/messages', async (req) => {
    const id = (req.params as { id: string }).id
    return { messages: repo.listMessages(tenantOf(req), id, 500) }
  })

  // AI 分析：按会话
  app.post('/api/analyze/conversation/:id', async (req, reply) => {
    if (!analyzer) return reply.code(501).send({ error: 'AI 分析未配置（缺少 ANTHROPIC_API_KEY）' })
    const id = (req.params as { id: string }).id
    const messages = repo.listMessages(tenantOf(req), id, 500)
    return { analysis: await analyzer.analyze(messages) }
  })

  // AI 分析：按客户（跨会话/账号聚合该客户的全部对话）
  app.post('/api/analyze/contact/:contactId', async (req, reply) => {
    if (!analyzer) return reply.code(501).send({ error: 'AI 分析未配置（缺少 ANTHROPIC_API_KEY）' })
    const contactId = decodeURIComponent((req.params as { contactId: string }).contactId)
    const messages = repo.messagesByContact(tenantOf(req), contactId)
    return { analysis: await analyzer.analyze(messages) }
  })

  return app
}
