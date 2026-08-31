import { useMemo, useState } from 'react'
import type { AccountRow } from './AccountList'
import { useI18n } from '../i18n'

interface Props {
  target: AccountRow
  candidates: AccountRow[]
  onSubmit: (sourceKey: string, targetKey: string) => Promise<{ conversations: number; messages: number }>
  onClose: () => void
}

export function AccountInheritanceModal({ target, candidates, onSubmit, onClose }: Props): React.JSX.Element {
  const { t } = useI18n()
  const samePlatform = useMemo(() => candidates.filter((a) => a.state.kind === target.state.kind), [candidates, target.state.kind])
  const [sourceKey, setSourceKey] = useState(samePlatform[0]?.key ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ conversations: number; messages: number } | null>(null)
  const submit = async (): Promise<void> => {
    if (!sourceKey || busy) return
    setBusy(true)
    try {
      setResult(await onSubmit(sourceKey, target.key))
    } catch (error) {
      window.alert(`${t('account.inheritFailed')}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>{t('account.inherit')}</h2>
        <p className="field-hint">{t('account.inheritHint')}</p>
        <div className="account-inherit-target">
          <span>{t('account.inheritTarget')}</span><strong>{target.label}</strong><small>{target.key}</small>
        </div>
        {samePlatform.length === 0 ? (
          <p className="field-hint">{t('account.inheritNoSource')}</p>
        ) : (
          <label className="field">
            <span>{t('account.inheritSource')}</span>
            <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
              {samePlatform.map((account) => <option key={account.key} value={account.key}>{account.label}（{account.key}）</option>)}
            </select>
          </label>
        )}
        {result && <p className="save-ok">{t('account.inheritDone').replace('{conversations}', String(result.conversations)).replace('{messages}', String(result.messages))}</p>}
        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('settings.cancel')}</button>
          <button type="button" className="primary-btn" disabled={!sourceKey || busy || !!result} onClick={() => void submit()}>{t('account.inheritStart')}</button>
        </footer>
      </div>
    </div>
  )
}
