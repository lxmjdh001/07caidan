import { readFile } from 'node:fs/promises'
import type { UnifiedMessage } from '@shared/domain'

export interface TranscriberDeps {
  /** 找到消息（含媒体引用） */
  getMessages: (conversationId: string) => Promise<UnifiedMessage[]>
  /** mediaId → 本地绝对路径 */
  resolveMedia: (mediaId: string) => string | undefined
  /** 后台 ASR 调用 */
  asr: (body: {
    audioBase64: string
    mimeType: string
    durationSec: number
  }) => Promise<{ text: string }>
  /** 回写消息（含 transcript）并广播 */
  saveMessage: (msg: UnifiedMessage) => Promise<void>
}

export type TranscribeResult =
  | { ok: true; transcript: string; cached: boolean }
  | { ok: false; error: string }

/**
 * 语音消息转文字。
 *
 * 结果缓存在消息体上：同一条语音只花一次积分，重复点按钮直接回缓存。
 */
export async function transcribeMessage(
  deps: TranscriberDeps,
  conversationId: string,
  messageId: string
): Promise<TranscribeResult> {
  const messages = await deps.getMessages(conversationId)
  const msg = messages.find((m) => m.id === messageId)
  if (!msg) return { ok: false, error: '消息不存在' }
  const body = msg.body
  if (body.type !== 'media' || body.mediaType !== 'audio') {
    return { ok: false, error: '不是语音消息' }
  }
  if (body.transcript) return { ok: true, transcript: body.transcript, cached: true }
  if (!body.mediaId) return { ok: false, error: '语音尚未下载完成' }

  const path = deps.resolveMedia(body.mediaId)
  if (!path) return { ok: false, error: '语音文件不存在' }

  const audio = await readFile(path)
  // 时长未知时按文件大小粗估（opus ~2KB/s），计费宁多勿少由后端向上取整
  const durationSec = body.durationSec ?? Math.max(1, Math.round(audio.length / 2048))

  try {
    const r = await deps.asr({
      audioBase64: audio.toString('base64'),
      mimeType: body.mimeType ?? 'audio/ogg',
      durationSec
    })
    if (!r.text) return { ok: false, error: '未识别出内容' }
    // 回写缓存：下次免费
    await deps.saveMessage({ ...msg, body: { ...body, transcript: r.text } })
    return { ok: true, transcript: r.text, cached: false }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
