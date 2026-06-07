import type { UIToolCall } from '../types.js'

/** OUT 摘要的判别联合:单行计数 / 多行预览 / 错误单行。 */
export type OutputSummary =
  | { kind: 'line'; text: string }
  | { kind: 'preview'; lines: string[]; moreCount: number }
  | { kind: 'error'; text: string }

/** 匹配输出尾部的方括号状态/截断注记(可选前导 … 与多个换行)。 */
const TRAILING_NOTE_RE = /\n+…?\[[^\]]*\]\s*$/

/** 剥掉输出尾部的方括号状态/截断注记(可叠加多条),供行计数与预览前清洗。 */
export function stripTrailingNotes(output: string): string {
  let s = output
  while (TRAILING_NOTE_RE.test(s)) s = s.replace(TRAILING_NOTE_RE, '')
  return s
}

/** 数行数:空串 0,否则按 \n 切。调用方应先 stripTrailingNotes。 */
export function countLines(body: string): number {
  if (body === '') return 0
  return body.split('\n').length
}

/** 取正文前 maxLines 行作预览,余下行数记入 moreCount。调用方应先 stripTrailingNotes。 */
export function previewLines(body: string, maxLines: number): { lines: string[]; moreCount: number } {
  const all = body === '' ? [] : body.split('\n')
  return { lines: all.slice(0, maxLines), moreCount: Math.max(0, all.length - maxLines) }
}
