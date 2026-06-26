import type { Part } from '../state/types.js'

export function ToolCall({ use, result }: { use: Extract<Part, { kind: 'tool-use' }>; result?: Extract<Part, { kind: 'tool-result' }> }) {
  const edits = editsFrom(use)
  const write = edits ? null : writeFrom(use)
  // Read/Glob/Grep: a single arg (file_path or pattern) is the gist → show it in the head and
  // let the result box below carry the content/matches, instead of the escaped-JSON args.
  const headArg = !edits && !write ? primaryArg(use) : null
  const file = edits?.file ?? write?.file ?? headArg
  return (
    <div className="tool">
      <div className="head">⚙ {use.name}{file ? <span className="tool-file">{file}</span> : null}</div>
      {edits
        ? edits.diffs.map((d, i) => <EditDiff key={i} lines={d} />)
        : write
        ? <pre className="write-body">{trunc(write.content, 4000)}</pre>
        : headArg !== null
        ? null
        : <div className="args">{trunc(safeJson(use.input), 200)}</div>}
      {result ? <div className={'result' + (result.isError ? ' err' : '')}>{trunc(result.output, 800)}</div> : null}
    </div>
  )
}

/**
 * Pull {file, content} out of a Write tool-use, or null for any other tool. Renders the
 * written file's content in a box with real line breaks instead of the escaped-JSON args.
 */
// Tools whose gist is one string arg: show that arg in the head, drop the args box, and let
// the result box carry the content/matches.
const PRIMARY_ARG: Record<string, string> = { Read: 'file_path', Glob: 'pattern', Grep: 'pattern' }

/** The headline arg of a Read/Glob/Grep tool-use (file_path or pattern), or null otherwise. */
function primaryArg(use: Extract<Part, { kind: 'tool-use' }>): string | null {
  const key = PRIMARY_ARG[use.name]
  if (!key) return null
  const inp = use.input as Record<string, unknown> | null | undefined
  return inp && typeof inp === 'object' && typeof inp[key] === 'string' ? (inp[key] as string) : null
}

function writeFrom(use: Extract<Part, { kind: 'tool-use' }>): { file: string; content: string } | null {
  if (use.name !== 'Write') return null
  const inp = use.input as { file_path?: unknown; content?: unknown } | null | undefined
  if (!inp || typeof inp !== 'object' || typeof inp.content !== 'string') return null
  return { file: typeof inp.file_path === 'string' ? inp.file_path : '', content: inp.content }
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
