/**
 * 把 IPC 错误转成可读文案。
 *
 * Electron 的 invoke 失败会把消息包成
 * "Error invoking remote method 'omni:xxx': Error: 真正的原因"，
 * 直接展示给用户就是一串英文噪音 —— 这里剥掉包装只留原因。
 */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
}
