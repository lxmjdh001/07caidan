import type { ChannelPluginInfo } from '@shared/ipc'
import { useI18n } from '../i18n'

const ICON: Record<string, { color: string; letter: string }> = {
  whatsapp: { color: '#22a06b', letter: 'W' },
  telegram: { color: '#2aabee', letter: 'T' },
  line: { color: '#06c755', letter: 'L' },
  kakaotalk: { color: '#fee500', letter: 'K' },
  facebook: { color: '#0866ff', letter: 'f' },
  instagram: { color: '#c13584', letter: '◎' },
  tiktok: { color: '#111111', letter: '♪' },
  x: { color: '#000000', letter: 'X' },
  snapchat: { color: '#fffc00', letter: 'S' }
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
                  {p.authType === 'qr'
                    ? t('picker.qr')
                    : p.authType === 'phone_code'
                      ? `${t('picker.qr')} / ${t('qr.tabPhone')}`
                      : p.authType === 'oauth'
                        ? t('picker.oauth')
                        : t('picker.credentials')}
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
