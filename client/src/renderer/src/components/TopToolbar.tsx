import {
  ArrowLeft,
  ArrowRight,
  Home,
  Languages,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  Sun,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { LOCALES, type Locale } from '../i18n'
import type { ThemeMode } from '@shared/settings'

interface Props {
  canBack: boolean
  canForward: boolean
  theme: ThemeMode
  locale: Locale
  zoom: number
  onHome: () => void
  onBack: () => void
  onForward: () => void
  onRefresh: () => void
  onTheme: (theme: ThemeMode) => void
  onLocale: (locale: Locale) => void
  onZoom: (delta: number) => void
  onResetZoom: () => void
}

export function TopToolbar({
  canBack,
  canForward,
  theme,
  locale,
  zoom,
  onHome,
  onBack,
  onForward,
  onRefresh,
  onTheme,
  onLocale,
  onZoom,
  onResetZoom
}: Props): React.JSX.Element {
  return (
    <header className="top-toolbar">
      <div className="top-toolbar-left">
        <button type="button" className="toolbar-icon toolbar-home" title="主页" onClick={onHome}>
          <Home size={18} strokeWidth={2.3} />
        </button>
        <button type="button" className="toolbar-icon" title="上一页" disabled={!canBack} onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <button type="button" className="toolbar-icon" title="下一页" disabled={!canForward} onClick={onForward}>
          <ArrowRight size={18} />
        </button>
        <button type="button" className="toolbar-icon" title="刷新" onClick={onRefresh}>
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="top-toolbar-right">
        <div className="toolbar-segmented" aria-label="主题">
          <button type="button" className={theme === 'light' ? 'on' : ''} title="日间模式" onClick={() => onTheme('light')}>
            <Sun size={15} />
          </button>
          <button type="button" className={theme === 'dark' ? 'on' : ''} title="夜间模式" onClick={() => onTheme('dark')}>
            <Moon size={15} />
          </button>
          <button type="button" className={theme === 'system' ? 'on' : ''} title="跟随系统" onClick={() => onTheme('system')}>
            <Monitor size={15} />
          </button>
        </div>

        <label className="toolbar-language" title="切换语言">
          <Languages size={16} />
          <select value={locale} onChange={(e) => onLocale(e.target.value as Locale)} aria-label="语言">
            {LOCALES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.nativeName}
              </option>
            ))}
          </select>
        </label>

        <div className="toolbar-zoom" aria-label="登录页缩放">
          <button type="button" className="toolbar-icon compact" title="缩小登录页" onClick={() => onZoom(-10)}>
            <ZoomOut size={15} />
          </button>
          <button type="button" className="zoom-value" title="重置登录页缩放" onClick={onResetZoom}>
            {zoom}%
          </button>
          <button type="button" className="toolbar-icon compact" title="放大登录页" onClick={() => onZoom(10)}>
            <ZoomIn size={15} />
          </button>
          <button type="button" className="toolbar-icon compact" title="重置登录页缩放" onClick={onResetZoom}>
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}
