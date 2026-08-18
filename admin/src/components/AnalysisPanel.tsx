import { useEffect, useState } from 'react'
import type { ApiClient, Conversation, IntentAnalysis } from '../api'
import { INTENT_LABEL } from '../util'
import { useI18n } from '../i18n'

interface Props {
  client: ApiClient
  conversation: Conversation
  canAnalyze: boolean
}

export function AnalysisPanel({ client, conversation, canAnalyze }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [analysis, setAnalysis] = useState<IntentAnalysis | null>(null)
  const [analyzedAt, setAnalyzedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // 切换会话时：清空并读取已落库的意向（自动打标签/上次深度分析），打开即展示，无需点按钮/无需 key
  useEffect(() => {
    setAnalysis(null)
    setAnalyzedAt(null)
    setErr('')
    let cancelled = false
    void client
      .getIntent(conversation.id)
      .then((r) => {
        if (cancelled || !r.intent) return
        const { analyzedAt: at, ...a } = r.intent
        setAnalysis(a)
        setAnalyzedAt(at)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [conversation.id, client])

  const run = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      // 有客户标识时按客户跨账号聚合分析，否则按当前会话
      const { analysis } = conversation.contactId
        ? await client.analyzeContact(conversation.contactId)
        : await client.analyzeConversation(conversation.id)
      setAnalysis(analysis)
      setAnalyzedAt(Date.now())
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg.includes('501') ? t('analysis.noKey') : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="analysis">
      <div className="analysis-head">
        <h3>{t('analysis.title')}</h3>
        {canAnalyze && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run()}>
            {busy ? t('analysis.running') : t('analysis.run')}
          </button>
        )}
      </div>
      <div className="analysis-body">
        {!canAnalyze && <div className="analysis-empty">{t('analysis.noPermission')}</div>}
        {canAnalyze && err && <div className="analysis-empty">{t('analysis.failed')}：{err}</div>}
        {!analysis && !err && !busy && (
          <div className="analysis-empty">
            {t('analysis.desc', {
              scope: conversation.contactId ? t('analysis.scopeContact') : ''
            })}
          </div>
        )}
        {busy && <div className="spin">{t('analysis.working')}</div>}
        {analysis && (
          <>
            <span className={`level ${analysis.intentLevel}`}>
              {INTENT_LABEL[analysis.intentLevel] ?? analysis.intentLevel}
            </span>
            {analyzedAt && (
              <span className="analysis-time">
                {t('analysis.analyzedAt', { time: new Date(analyzedAt).toLocaleString() })}
              </span>
            )}
            <h4>{t('analysis.summary')}</h4>
            <p>{analysis.summary}</p>
            <h4>{t('analysis.signals')}</h4>
            {analysis.signals.length > 0 ? (
              <div>
                {analysis.signals.map((s, i) => (
                  <span key={i} className="signal">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">{t('analysis.none')}</p>
            )}
            <h4>{t('analysis.suggestion')}</h4>
            <p>{analysis.suggestedAction}</p>
          </>
        )}
      </div>
    </aside>
  )
}
