/** 粘贴文本的行数标记 M（= 换行符个数，"a\nb\nc" → 2）。与 cc-haha getPastedTextRefNumLines 同义。
 *  web-local：不从 @zuse/core 引，因为 core 是 Node 引擎（node:fs/path），进浏览器包会让 Vite 构建炸。
 *  服务端 expandAttachments 只拼全文、不显示 "+M 行"，故此计数是纯前端展示逻辑，无跨端复用。 */
export function pastedLineCount(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

/** Card label for a pasted-text attachment: base name, plus "(+M 行)" when it spans >0 line breaks.
 *  Keeps the "+M 行" convention in one place (composer staged card + message bubble chip share it). */
export function pastedLabel(base: string, lineCount: number): string {
  return lineCount === 0 ? base : `${base} (+${lineCount} 行)`
}
