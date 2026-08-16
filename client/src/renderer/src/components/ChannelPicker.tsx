import type { ChannelPluginInfo } from '@shared/ipc'
import { useI18n } from '../i18n'

const ICON: Record<string, { color: string; letter: string }> = {
  whatsapp: { color: '#22a06b', letter: 'W' },
  telegram: { color: '#2aabee', letter: 'T' },
  line: { color: '#06c755', letter: 'L' }
}

interface Props {
  plugins: ChannelPluginInfo[]
  onPick: (kind: string) => void
  onClose: () => void
}

/** 新增账号时选择平台类型 */
export function ChannelPicker({ plugins, onPick, onClose }: Props): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <h2>{t('picker.title')}</h2>
        <div className="picker-grid">
          {plugins.map((p) => {
            const ic = ICON[p.kind] ?? { color: '#888', letter: p.displayName[0] ?? '?' }
            return (
              <button key={p.kind} type="button" className="picker-item" onClick={() => onPick(p.kind)}>
                <span className="picker-icon" style={{ background: ic.color }}>
                  {ic.letter}
                </span>
                <span className="picker-name">{p.displayName}</span>
                <span className="picker-auth">
                  {p.authType === 'qr' ? t('picker.qr') : t('picker.credentials')}
                </span>
              </button>
            )
          })}
        </div>
        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
        </footer>
      </div>
    </div>
  )
}
