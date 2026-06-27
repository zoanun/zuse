import type { Part } from '../state/types.js'

export function ToolCall({ use, result }: { use: Extract<Part, { kind: 'tool-use' }>; result?: Extract<Part, { kind: 'tool-result' }> }) {
  const { name, tag, head, body } = describe(use)
  return (
    <div className="tool">
      <div className="head">⚙ {name ?? use.name}{tag ? <span className="tool-tag">{tag}</span> : null}{head ? <span className="tool-file">{head}</span> : null}</div>
      {body?.kind === 'diff'
        ? body.diffs.map((d, i) => <EditDiff key={i} lines={d} />)
        : body?.kind === 'code'
        ? <pre className={body.cls}>{trunc(body.text, 4000)}</pre>
        : body?.kind === 'json'
        ? <div className="args">{trunc(body.text, 200)}</div>
        : null}
      {result ? <div className={'result' + (result.isError ? ' err' : '')}>{trunc(result.output, 800)}</div> : null}
    </div>
  )
}

/** What renders below the head: a line diff, a monospace box, raw-JSON args, or nothing. */
type Body =
  | { kind: 'diff'; diffs: DiffLine[][] }
  | { kind: 'code'; text: string; cls: string }
  | { kind: 'json'; text: string }
  | null

// Tools whose gist is one string arg: show that arg in the head, drop the body, and let the
// result box below carry the content/matches.
const PRIMARY_ARG: Record<string, string> = {
  Read: 'file_path', Glob: 'pattern', Grep: 'pattern',
  WebFetch: 'url', WebSearch: 'query', Skill: 'name', LspInstall: 'lang',
}

/** The descriptor that drives a tool card: optional name override + source tag, head, body. */
interface Desc { name?: string; tag?: string; head: string | null; body: Body }

/**
 * Decide how a tool-use renders: an optional display `name`/source `tag`, the muted `head`
 * after the tool name, and the `body` below. Each tool surfaces its real arguments (a diff,
 * the file content, the command, the query…) instead of escaped JSON; the raw-JSON args
 * remain the fallback for anything unrecognised.
 */
function describe(use: Extract<Part, { kind: 'tool-use' }>): Desc {
  const inp = (use.input ?? {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof inp[k] === 'string' ? (inp[k] as string) : undefined)
  const json = (): Desc => ({ head: null, body: { kind: 'json', text: safeJson(use.input) } })

  // MCP tools are registered as `mcp__<server>__<tool>`: show the clean tool name with a
  // "MCP · <server>" badge. A single short scalar arg goes inline in the head (echo · message:
  // "hello"); anything else (multiple args / long / non-scalar) keeps the pretty-JSON box so a
  // busy call never crowds the title.
  if (use.name.startsWith('mcp__')) {
    const rest = use.name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    const server = sep >= 0 ? rest.slice(0, sep) : ''
    const tool = sep >= 0 ? rest.slice(sep + 2) : rest
    const tag = server ? `MCP · ${server}` : 'MCP'
    const inline = inlineArg(use.input)
    if (inline !== null) return { name: tool, tag, head: inline, body: null }
    const pretty = prettyJson(use.input)
    return { name: tool, tag, head: null, body: pretty ? code(pretty) : null }
  }

  // Edit / MultiEdit → file in head + line diff.
  const edits = editsFrom(use)
  if (edits) return { head: edits.file, body: { kind: 'diff', diffs: edits.diffs } }

  // One primary string arg → head only (content/matches show in the result box).
  const pk = PRIMARY_ARG[use.name]
  if (pk) { const v = str(pk); return v !== undefined ? { head: v, body: null } : json() }

  switch (use.name) {
    case 'Write': { const c = str('content'); return c !== undefined ? { head: str('file_path') ?? null, body: code(c) } : json() }
    case 'Bash': { const c = str('command'); return c !== undefined ? { head: str('description') ?? null, body: code(c, 'bash-cmd') } : json() }
    case 'Agent': { const p = str('prompt'); return p !== undefined ? { head: str('description') ?? null, body: code(p) } : json() }
    case 'ScheduleWakeup': {
      const m = str('message')
      const head = typeof inp.delaySeconds === 'number' ? `in ${inp.delaySeconds}s` : null
      return m !== undefined ? { head, body: code(m) } : json()
    }
    case 'Memory': {
      const action = str('action')
      if (!action) return json()
      const t = str('type')
      const text = str('content') ?? str('query') ?? str('hook')
      return { head: t ? `${action} · ${t}` : action, body: text !== undefined ? code(text) : null }
    }
    case 'Lsp': {
      const op = str('operation')
      if (!op) return json()
      const sym = str('symbol')
      return { head: sym ? `${op}: ${sym}` : op, body: null }
    }
    case 'McpSearch': {
      const action = str('action')
      if (!action) return json()
      const arg = str('query') ?? str('tool')
      return { head: arg ? `${action}: ${arg}` : action, body: null }
    }
    default: return json()
  }
}

const code = (text: string, cls = 'write-body'): Body => ({ kind: 'code', text, cls })

/**
 * If the input is exactly one short scalar arg, format it as `key: value` for the head
 * (strings quoted) — else null so the caller keeps the JSON box. Keeps single-arg MCP calls
 * compact without crowding the title when there are many/complex args.
 */
function inlineArg(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const keys = Object.keys(input)
  if (keys.length !== 1) return null
  const k = keys[0]!
  const v = (input as Record<string, unknown>)[k]
  if (typeof v === 'string') return v.length <= 60 ? `${k}: ${JSON.stringify(v)}` : null
  if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`
  return null
}

// Pretty-print MCP args (2-space indent) so arbitrary tool inputs read as JSON instead of one
// cramped line; '' for an empty/absent object so the card shows just the name + tag.
function prettyJson(o: unknown): string {
  if (!o || typeof o !== 'object' || Object.keys(o as object).length === 0) return ''
  try { return JSON.stringify(o, null, 2) ?? '' } catch { return '' }
}

/** A computed diff for one Edit (or each edit of a MultiEdit). */
function EditDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="edit-diff">
      {lines.map((l, i) => (
        <div key={i} className={'dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx')}>
          <span className="dl-sign" aria-hidden="true">{l.t === ' ' ? ' ' : l.t}</span>
          <span className="dl-text">{l.text || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

const MAX_DIFF_LINES = 200

/**
 * Pull the {file, diffs} out of an Edit / MultiEdit tool-use, or null for any other tool
 * (which falls back to the raw-JSON args view). Edit = one diff; MultiEdit = one per edit.
 */
function editsFrom(use: Extract<Part, { kind: 'tool-use' }>): { file: string; diffs: DiffLine[][] } | null {
  const inp = use.input as
    | { file_path?: unknown; old_string?: unknown; new_string?: unknown; edits?: unknown }
    | null
    | undefined
  if (!inp || typeof inp !== 'object') return null
  const file = typeof inp.file_path === 'string' ? inp.file_path : ''
  if (use.name === 'Edit' && typeof inp.old_string === 'string' && typeof inp.new_string === 'string') {
    return { file, diffs: [lineDiff(inp.old_string, inp.new_string)] }
  }
  if (use.name === 'MultiEdit' && Array.isArray(inp.edits)) {
    const diffs = inp.edits
      .filter((e): e is { old_string: string; new_string: string } =>
        !!e && typeof e === 'object' && typeof (e as { old_string?: unknown }).old_string === 'string' && typeof (e as { new_string?: unknown }).new_string === 'string')
      .map((e) => lineDiff(e.old_string, e.new_string))
    return diffs.length ? { file, diffs } : null
  }
  return null
}

interface DiffLine { t: ' ' | '-' | '+'; text: string }

/**
 * Line-level diff (LCS) of old → new: common lines as context, removed as '-', added as '+'.
 * Capped at MAX_DIFF_LINES so a huge edit can't blow up the render.
 */
function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  const n = a.length
  const m = b.length
  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', text: a[i]! }); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ t: '-', text: a[i]! }); i++ }
    else { out.push({ t: '+', text: b[j]! }); j++ }
  }
  while (i < n) out.push({ t: '-', text: a[i++]! })
  while (j < m) out.push({ t: '+', text: b[j++]! })
  if (out.length > MAX_DIFF_LINES) {
    const extra = out.length - MAX_DIFF_LINES
    return [...out.slice(0, MAX_DIFF_LINES), { t: ' ', text: `… (+${extra} more lines)` }]
  }
  return out
}

// JSON.stringify returns the value `undefined` (not a string) for undefined/functions/symbols;
// the `?? String(o)` guard turns those into a real string so trunc() can't throw on .length.
function safeJson(o: unknown): string { try { return JSON.stringify(o) ?? String(o) } catch { return String(o) } }
function trunc(s: string, n: number): string { return s.length > n ? s.slice(0, n) + ' … (+' + (s.length - n) + ' chars)' : s }
