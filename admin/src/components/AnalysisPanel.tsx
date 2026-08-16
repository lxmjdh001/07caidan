import { useEffect, useState } from 'react'
import type { ApiClient, Conversation, IntentAnalysis } from '../api'
import { INTENT_LABEL } from '../util'

interface Props {
  client: ApiClient
  conversation: Conversation
  canAnalyze: boolean
}

export function AnalysisPanel({ client, conversation, canAnalyze }: Props): React.JSX.Element {
  const [analysis, setAnalysis] = useState<IntentAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // 切换会话时清空结果
  useEffect(() => {
    setAnalysis(null)
    setErr('')
  }, [conversation.id])

  const run = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      // 有客户标识时按客户跨账号聚合分析，否则按当前会话
      const { analysis } = conversation.contactId
        ? await client.analyzeContact(conversation.contactId)
        : await client.analyzeConversation(conversation.id)
      setAnalysis(analysis)
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg.includes('501') ? '后台未配置 AI（缺少 ANTHROPIC_API_KEY）' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="analysis">
      <div className="analysis-head">
        <h3>AI 意向分析</h3>
        {canAnalyze && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run()}>
            {busy ? '分析中…' : '分析意向'}
          </button>
        )}
      </div>
      <div className="analysis-body">
        {!canAnalyze && <div className="analysis-empty">你没有「运行 AI 分析」权限。</div>}
        {canAnalyze && err && <div className="analysis-empty">分析失败：{err}</div>}
        {!analysis && !err && !busy && (
          <div className="analysis-empty">
            点击「分析意向」，用 AI 分析该客户
            {conversation.contactId ? '（跨账号聚合其全部对话）' : ''}的购买意向、关键信号与跟进建议。
          </div>
        )}
        {busy && <div className="spin">AI 分析中…（可能需要数秒）</div>}
        {analysis && (
          <>
            <span className={`level ${analysis.intentLevel}`}>
              {INTENT_LABEL[analysis.intentLevel] ?? analysis.intentLevel}
            </span>
            <h4>意向摘要</h4>
            <p>{analysis.summary}</p>
            <h4>关键信号</h4>
            {analysis.signals.length > 0 ? (
              <div>
                {analysis.signals.map((s, i) => (
                  <span key={i} className="signal">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">无</p>
            )}
            <h4>建议跟进</h4>
            <p>{analysis.suggestedAction}</p>
          </>
        )}
      </div>
    </aside>
  )
}
