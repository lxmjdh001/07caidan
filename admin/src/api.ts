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
}
