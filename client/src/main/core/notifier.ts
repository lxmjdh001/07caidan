import { app, BrowserWindow, Notification } from 'electron'
import { brand } from '@shared/branding'
import type { Conversation, UnifiedMessage } from '@shared/domain'
import type { NotificationConfig } from '@shared/settings'
import { noopLogger, type Logger } from './logger'

/** 通知里最多展示多少字正文，超出截断 */
const PREVIEW_MAX = 60
/** 同一会话的通知合并窗口：短时间内连发不刷屏 */
const COALESCE_MS = 4000

export interface NotifierOptions {
  getConfig: () => NotificationConfig
  logger?: Logger
  /** 点击通知后跳转到该会话 */
  onActivate: (conversationId: string) => void
}

/**
 * 系统通知 + 任务栏/程序坞角标。
 *
 * 客服常同时开十几个账号又不会一直盯着窗口，未读只画在应用内是不够的：
 * 窗口没聚焦时要能从系统层面知道「哪个账号来了几条」。
 */
export class Notifier {
  private readonly opts: NotifierOptions
  private readonly log: Logger
  /** 会话 → 上次通知时间，用于合并连发 */
  private readonly lastNotifiedAt = new Map<string, number>()
  private badge = 0

  constructor(opts: NotifierOptions) {
    this.opts = opts
    this.log = (opts.logger ?? noopLogger).child('notifier')
  }

  /** 更新系统角标；渲染进程算好总未读后调用 */
  setUnreadTotal(total: number): void {
    const next = Math.max(0, Math.floor(total))
    if (next === this.badge) return
    this.badge = next
    // macOS / 部分 Linux 桌面：程序坞数字角标
    if (app.isReady()) app.setBadgeCount(next)
    // Windows 没有数字角标，用任务栏闪烁提示（已聚焦时不闪，避免打扰）
    if (process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isFocused()) win.flashFrame(next > 0)
      }
    }
  }

  /**
   * 新的入站消息 → 弹系统通知。
   * 窗口已聚焦时不弹（用户就在看，应用内角标够了）。
   */
  notifyInbound(message: UnifiedMessage, conversation: Conversation, accountLabel?: string): void {
    const cfg = this.opts.getConfig()
    if (!cfg.enabled) return
    if (message.direction !== 'in') return
    if (conversation.muted) return
    if (!Notification.isSupported()) return

    const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused() && w.isVisible())
    if (focused) return

    const now = Date.now()
    const last = this.lastNotifiedAt.get(conversation.id) ?? 0
    if (now - last < COALESCE_MS) return
    this.lastNotifiedAt.set(conversation.id, now)

    // 标题带上账号，客服才知道是哪个号来的客
    const who = conversation.title || message.authorName || ''
    const title = accountLabel ? `${who} · ${accountLabel}` : who

    try {
      const n = new Notification({
        title: title || brand.appName,
        body: cfg.showPreview ? preview(message) : bodyKind(message),
        silent: !cfg.sound
      })
      n.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
        this.opts.onActivate(conversation.id)
      })
      n.show()
    } catch (err) {
      // 通知失败不能影响收消息
      this.log.warn('系统通知失败', { err: String(err) })
    }
  }

  /** 窗口重新聚焦时清掉 Windows 的闪烁 */
  clearFlash(): void {
    if (process.platform !== 'win32') return
    for (const win of BrowserWindow.getAllWindows()) win.flashFrame(false)
  }
}

/** 通知正文：文本截断，媒体给类型描述 */
export function preview(message: UnifiedMessage): string {
  const b = message.body
  if (b.type === 'text') return truncate(b.text)
  if (b.type === 'media') return b.caption ? truncate(b.caption) : bodyKind(message)
  return bodyKind(message)
}

/** 不展示正文时的替代描述（也用于不支持的消息类型） */
export function bodyKind(message: UnifiedMessage): string {
  const b = message.body
  if (b.type === 'text') return '[新消息]'
  if (b.type === 'media') {
    const map: Record<string, string> = {
      image: '[图片]',
      video: '[视频]',
      audio: '[语音]',
      document: '[文件]',
      sticker: '[表情]'
    }
    return map[b.mediaType] ?? '[附件]'
  }
  return '[新消息]'
}

export function truncate(text: string, max = PREVIEW_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}
