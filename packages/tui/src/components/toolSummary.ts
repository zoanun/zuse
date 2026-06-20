import type { UIToolCall } from '../types.js'

/** OUT 摘要的判别联合:单行计数 / 多行预览 / 文件清单(可点击) / 错误单行。 */
export type OutputSummary =
  | { kind: 'line'; text: string }
  | { kind: 'preview'; lines: string[]; moreCount: number }
  | { kind: 'files'; paths: string[]; moreCount: number }
  | { kind: 'error'; text: string }
  | { kind: 'todo'; lines: string[] }

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
    case 'Memory': {
      // 记忆操作可读化:save 显示要点(hook 优先),search/recall 显示检索词,
      // delete 显示 id —— 用户一眼看出「现在在存/查什么记忆」。
      const action = strField(obj, 'action') ?? ''
      const detail =
        action === 'save'
          ? (strField(obj, 'hook') ?? strField(obj, 'content') ?? '')
          : action === 'search' || action === 'recall'
            ? (strField(obj, 'query') ?? '')
            : action === 'delete'
              ? String((obj as { id?: unknown }).id ?? '')
              : ''
      const capped = detail.length > SPECIFIER_MAX ? detail.slice(0, SPECIFIER_MAX) + '…' : detail
      return capped ? `${action}: ${capped}` : action || fallbackJson(obj)
    }
    case 'LSP': {
      const op = strField(obj, 'operation')
      const sym = strField(obj, 'symbol')
      if (op && sym) return `${op} ${sym}`
      return op ?? fallbackJson(obj)
    }
    case 'Agent':
      return strField(obj, 'description') ?? fallbackJson(obj)
    default:
      return fallbackJson(obj)
  }
}

/** Bash 类「输出即价值」工具:输出本身就是要看的内容(Task 5 给多行预览)。 */
function isOutputValueTool(name: string): boolean {
  return name === 'Bash' || name === 'WebFetch' || name === 'WebSearch' || name === 'LSP' || name === 'Agent'
}

/** "1 line" / "N lines" 之类的单复数;不规则复数(match→matches)传第三参。 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular + 's')}`
}

function readSummary(output: string): OutputSummary {
  if (output.startsWith('(file is empty:')) return { kind: 'line', text: '(empty file)' }
  return { kind: 'line', text: `Read ${plural(countLines(stripTrailingNotes(output)), 'line')}` }
}

// 文件清单(Glob / Grep files 模式)行内最多列出的路径条数:其余记入 moreCount。
// 与 Bash 预览同样收得很短,保持帧紧凑;命中文件由渲染层逐行包成可点击链接。
const FILE_LIST_MAX = 3

function globSummary(output: string): OutputSummary {
  if (output.startsWith('No files match:')) return { kind: 'line', text: 'No files matched' }
  // 列出命中文件(相对路径),渲染层据 cwd 拼绝对路径再包成 OSC 8 链接。
  const { lines, moreCount } = previewLines(stripTrailingNotes(output), FILE_LIST_MAX)
  return { kind: 'files', paths: lines, moreCount }
}

/** Grep 输出是否「无命中」(content/count/files 各模式的空结果前缀)。 */
function isGrepNoMatch(output: string): boolean {
  return output.startsWith('No matches for:') || output.startsWith('[offset ')
}

function grepSummary(tool: UIToolCall): OutputSummary {
  const output = tool.output ?? ''
  if (isGrepNoMatch(output)) {
    return { kind: 'line', text: 'No matches found' }
  }
  const body = stripTrailingNotes(output)
  const mode = (tool.input as { output_mode?: unknown }).output_mode
  if (mode === 'count') {
    let matches = 0
    let files = 0
    for (const line of body.split('\n')) {
      const idx = line.lastIndexOf(':') // 路径可能含 ':'(Windows 盘符),取最后一个
      if (idx === -1) continue
      const n = Number(line.slice(idx + 1))
      if (Number.isFinite(n)) {
        matches += n
        files += 1
      }
    }
    return { kind: 'line', text: `Found ${plural(matches, 'match', 'matches')} in ${plural(files, 'file')}` }
  }
  const n = countLines(body)
  if (mode === 'content') return { kind: 'line', text: `Found ${plural(n, 'line')}` }
  // files_with_matches(默认):列出命中文件,渲染层包成可点击链接。
  const { lines, moreCount } = previewLines(body, FILE_LIST_MAX)
  return { kind: 'files', paths: lines, moreCount }
}

function editSummary(tool: UIToolCall): OutputSummary {
  const file = strField(tool.input as Record<string, unknown>, 'file_path') ?? ''
  const m = (tool.output ?? '').match(/\((\d+) replacement/)
  const n = m?.[1] ?? '1'
  return { kind: 'line', text: `Updated ${file} (${n} replacement(s))` }
}

function writeSummary(tool: UIToolCall): OutputSummary {
  const content = (tool.input as { content?: unknown }).content
  const n = typeof content === 'string' ? countLines(content) : 0
  return { kind: 'line', text: `Wrote ${plural(n, 'line')}` }
}

// Bash 类工具的 OUT 行内只展示前若干行,保持帧紧凑、不刷屏。超出部分不再硬塞进终端:
// 完整输出由 hook 落盘到临时文件,UI 给出可 ctrl+点击的路径(见 useConversation 的 tool-result
// 处理与 StreamRenderer 的 OutputCell)。模型侧拿到的始终是完整输出,截断只发生在展示层。
const PREVIEW_MAX = 3

function bashPreview(output: string, isError: boolean): OutputSummary {
  if (output === '(no output)') return { kind: 'line', text: '(no output)' }
  const body = stripTrailingNotes(output)
  if (body === '') {
    // 仅有状态尾注、无正文:出错取首行(渲染层着红),否则视作无输出。
    return isError
      ? { kind: 'error', text: output.split('\n')[0] ?? '' }
      : { kind: 'line', text: '(no output)' }
  }
  const { lines, moreCount } = previewLines(body, PREVIEW_MAX)
  return { kind: 'preview', lines, moreCount }
}

/** 该工具的 line 摘要是否「隐藏了完整内容」、值得落盘给链接(当前:Grep content/count 有命中)。 */
export function lineSummaryHidesContent(tool: UIToolCall): boolean {
  if (tool.name !== 'Grep') return false
  const mode = (tool.input as { output_mode?: unknown }).output_mode
  if (mode !== 'content' && mode !== 'count') return false
  const out = tool.output ?? ''
  return !isGrepNoMatch(out)
}

/** 渲染期从 name + input + output 推导 `⎿` 行摘要(纯函数,不调用工具)。 */
export function summarizeOutput(tool: UIToolCall): OutputSummary {
  const output = tool.output ?? ''
  if (tool.isError) {
    // Bash 类即便出错也保留多行预览(报错/测试正文常多行,Task 5 实现);
    // 其余工具错误取首行,渲染层据 tool.isError 着红。
    if (!isOutputValueTool(tool.name)) {
      return { kind: 'error', text: output.split('\n')[0] ?? '' }
    }
  }
  switch (tool.name) {
    case 'Read':
      return readSummary(output)
    case 'Glob':
      return globSummary(output)
    case 'Grep':
      return grepSummary(tool)
    case 'Edit':
      return editSummary(tool)
    case 'Write':
      return writeSummary(tool)
    case 'Bash':
    case 'WebFetch':
    case 'WebSearch':
    case 'LSP':
      return bashPreview(output, tool.isError ?? false)
    case 'TodoWrite': {
      const body = stripTrailingNotes(output)
      return { kind: 'todo', lines: body === '' ? [] : body.split('\n') }
    }
    default:
      return { kind: 'line', text: `${plural(countLines(stripTrailingNotes(output)), 'line')} of output` }
  }
}
