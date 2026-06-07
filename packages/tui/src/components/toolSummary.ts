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

/** specifier 与 JSON 兜底的展示长度上限。 */
const SPECIFIER_MAX = 60

/** 把对象压成 ≤60 字符的 JSON(超出加 …),作为 specifier 兜底。 */
function fallbackJson(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj)
  return json.length > SPECIFIER_MAX ? json.slice(0, SPECIFIER_MAX) + '…' : json
}

/** 取字符串字段,非字符串返回 undefined。 */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/** 标题行括注:按工具显示主参数;取不到回落到压缩 JSON。 */
export function toolSpecifier(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return strField(obj, 'file_path') ?? fallbackJson(obj)
    case 'Glob':
    case 'Grep':
      return strField(obj, 'pattern') ?? fallbackJson(obj)
    case 'Bash': {
      const cmd = strField(obj, 'command')
      if (cmd === undefined) return fallbackJson(obj)
      return cmd.length > SPECIFIER_MAX ? cmd.slice(0, SPECIFIER_MAX) + '…' : cmd
    }
    case 'WebFetch':
      return strField(obj, 'url') ?? fallbackJson(obj)
    case 'WebSearch':
      return strField(obj, 'query') ?? fallbackJson(obj)
    case 'LSP': {
      const op = strField(obj, 'operation')
      const sym = strField(obj, 'symbol')
      if (op && sym) return `${op} ${sym}`
      return op ?? fallbackJson(obj)
    }
    default:
      return fallbackJson(obj)
  }
}
