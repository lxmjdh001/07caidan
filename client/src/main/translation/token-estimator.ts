/**
 * 本地 Token 估算器。
 *
 * 传统翻译接口通常不返回 tokenizer 用量。这里不上传聊天原文，按常见 BPE
 * 的近似规律在本机计算：中日韩字符通常约 1 token，其他 UTF-8 内容约
 * 4 bytes/token。服务商返回真实用量时始终优先使用真实值。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let otherBytes = 0
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
      cjk++
    } else {
      otherBytes += Buffer.byteLength(char, 'utf8')
    }
  }
  const estimated = cjk + Math.ceil(otherBytes / 4)
  return text.length > 0 ? Math.max(1, estimated) : 0
}
