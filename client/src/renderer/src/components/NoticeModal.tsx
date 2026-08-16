import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

const api = window.omni

interface AnnouncementItem {
  id: string
  title: string
  body: string
  createdAt: number
}

interface NoticeItem {
  id: number
  kind: string
  title: string
  body: string
  createdAt: number
}

/**
 * 未读通知弹窗（运营公告 + 到期提醒等个人通知）。
 * 启动与每 30 分钟拉一次；关闭即全部标记已读 ——
 * 强制逐条确认只会让用户烦，重要的事运营应该发多次。
 */
export function useNotices(): {
  announcements: AnnouncementItem[]
  notices: NoticeItem[]
  dismiss: () => void
} {
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [notices, setNotices] = useState<NoticeItem[]>([])

  useEffect(() => {
    let stopped = false
    const fetchNotices = async (): Promise<void> => {
      try {
        const r = await api.billing<{ announcements: AnnouncementItem[]; notices: NoticeItem[] }>(
          'listNotices'
        )
        if (stopped) return
        setAnnouncements(r.announcements ?? [])
        setNotices(r.notices ?? [])
      } catch {
        // 未登录后台等情况：静默，不打扰
      }
    }
    void fetchNotices()
    const timer = setInterval(() => void fetchNotices(), 30 * 60 * 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  const dismiss = (): void => {
    const announcementIds = announcements.map((a) => a.id)
    const noticeIds = notices.map((n) => n.id)
    setAnnouncements([])
    setNotices([])
    void api.billing('markNoticesRead', { announcementIds, noticeIds }).catch(() => undefined)
  }

  return { announcements, notices, dismiss }
}

export function NoticeModal({
  announcements,
  notices,
  onClose
}: {
  announcements: AnnouncementItem[]
  notices: NoticeItem[]
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (announcements.length === 0 && notices.length === 0) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>{t('notice.title')}</h2>
        <div className="notice-scroll">
          {notices.map((n) => (
            <div key={`n${n.id}`} className="notice-item notice-personal">
              <h3>{n.title}</h3>
              <p>{n.body}</p>
            </div>
          ))}
          {announcements.map((a) => (
            <div key={a.id} className="notice-item">
              <h3>{a.title}</h3>
              <p>{a.body}</p>
              <span className="notice-time">{new Date(a.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
        <footer className="modal-footer">
          <button type="button" className="primary-btn" onClick={onClose}>
            {t('notice.gotIt')}
          </button>
        </footer>
      </div>
    </div>
  )
}
