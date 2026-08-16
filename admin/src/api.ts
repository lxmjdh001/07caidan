/** 管理后台 API 客户端（前后端分离，调用 server 的 REST 接口） */

export interface Conversation {
  id: string
  channel: string
  accountId: string
  contactId?: string
  title: string
  isGroup: boolean
  lastMessageAt: number
}

export interface Message {
  externalId: string
  conversationId: string
  channel: string
  accountId: string
  direction: 'in' | 'out'
  authorName?: string
  bodyType: 'text' | 'media' | 'unsupported'
  text?: string
  mediaType?: string
  caption?: string
  translationText?: string
  timestamp: number
}

export interface IntentAnalysis {
  intentLevel: 'high' | 'medium' | 'low' | 'unknown'
  summary: string
  signals: string[]
  suggestedAction: string
}

export interface Me {
  username: string
  role: string
  permissions: string[]
}

export interface AdminUser {
  id: number
  username: string
  role: string
  permissions: string[]
  enabled: boolean
}

export interface PermMeta {
  permissions: string[]
  roles: string[]
  rolePresets: Record<string, string[]>
}

/** 账号密码登录，成功返回访问令牌与用户信息 */
export async function login(
  base: string,
  username: string,
  password: string
): Promise<{ token: string; user: Me }> {
  const res = await fetch(base.replace(/\/$/, '') + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<{ token: string; user: Me }>
}

export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly token: string
  ) {}

  private async req<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base.replace(/\/$/, '') + path, {
      ...opts,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...opts.headers
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  listConversations(limit = 200): Promise<{ conversations: Conversation[] }> {
    return this.req(`/api/conversations?limit=${limit}`)
  }

  listMessages(id: string): Promise<{ messages: Message[] }> {
    return this.req(`/api/conversations/${encodeURIComponent(id)}/messages`)
  }

  analyzeConversation(id: string): Promise<{ analysis: IntentAnalysis }> {
    return this.req(`/api/analyze/conversation/${encodeURIComponent(id)}`, { method: 'POST' })
  }

  analyzeContact(contactId: string): Promise<{ analysis: IntentAnalysis }> {
    return this.req(`/api/analyze/contact/${encodeURIComponent(contactId)}`, { method: 'POST' })
  }

  me(): Promise<Me> {
    return this.req('/api/me')
  }

  logout(): Promise<{ ok: boolean }> {
    return this.req('/api/logout', { method: 'POST' })
  }

  // ── 用户管理（需 users:manage）──
  permMeta(): Promise<PermMeta> {
    return this.req('/api/meta/permissions')
  }

  listUsers(): Promise<{ users: AdminUser[] }> {
    return this.req('/api/users')
  }

  createUser(body: {
    username: string
    password: string
    role: string
    permissions: string[]
  }): Promise<{ user: AdminUser }> {
    return this.req('/api/users', { method: 'POST', body: JSON.stringify(body) })
  }

  updateUser(
    id: number,
    body: { role?: string; permissions?: string[]; enabled?: boolean; password?: string }
  ): Promise<{ ok: boolean }> {
    return this.req(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  }

  deleteUser(id: number): Promise<{ ok: boolean }> {
    return this.req(`/api/users/${id}`, { method: 'DELETE' })
  }
}
