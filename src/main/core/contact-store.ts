import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 联系人登记表：以规范标识（wa:+手机号 等）为主键，跨己方所有账号共享。
 * 用途：识别同一客户在不同账号/渠道找过我、沉淀客户名称历史。
 */
export interface ContactRecord {
  id: string
  /** 见过的显示名（昵称变化全保留，最新的在最后） */
  names: string[]
  /** 该客户出现过的所有会话（含不同己方账号） */
  conversationIds: string[]
  firstSeenAt: number
  lastSeenAt: number
}

interface ContactData {
  version: 1
  contacts: Record<string, ContactRecord>
}

export class JsonContactStore {
  private readonly filePath: string
  private data: ContactData = { version: 1, contacts: {} }
  private dirty = false

  constructor(dir: string) {
    this.filePath = join(dir, 'contacts.json')
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ContactData
      if (parsed.version === 1) this.data = parsed
    } catch {
      // 首次运行
    }
  }

  /**
   * 登记联系人出现在某会话。返回该联系人此前已出现过的其他会话
   * （非空即说明"这个客户之前聊过"，可能在别的账号上）。
   */
  async record(
    contactId: string,
    conversationId: string,
    name?: string
  ): Promise<{ otherConversations: string[] }> {
    const now = Date.now()
    let rec = this.data.contacts[contactId]
    if (!rec) {
      rec = { id: contactId, names: [], conversationIds: [], firstSeenAt: now, lastSeenAt: now }
      this.data.contacts[contactId] = rec
    }
    const others = rec.conversationIds.filter((id) => id !== conversationId)
    if (!rec.conversationIds.includes(conversationId)) {
      rec.conversationIds.push(conversationId)
      this.dirty = true
    }
    if (name && rec.names[rec.names.length - 1] !== name && !name.startsWith('+')) {
      rec.names.push(name)
      this.dirty = true
    }
    rec.lastSeenAt = now
    this.dirty = true
    await this.flush()
    return { otherConversations: others }
  }

  get(contactId: string): ContactRecord | undefined {
    return this.data.contacts[contactId]
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data), 'utf8')
    await rename(tmp, this.filePath)
  }
}
