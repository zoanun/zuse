import type { Part } from '../state/types.js'

export function ToolCall({ use, result }: { use: Extract<Part, { kind: 'tool-use' }>; result?: Extract<Part, { kind: 'tool-result' }> }) {
  return (
    <div className="tool">
      <div className="head">⚙ {use.name}</div>
      <div className="args">{trunc(safeJson(use.input), 200)}</div>
      {result ? <div className={'result' + (result.isError ? ' err' : '')}>{trunc(result.output, 800)}</div> : null}
    </div>
  )
}

// JSON.stringify returns the value `undefined` (not a string) for undefined/functions/symbols;
// the `?? String(o)` guard turns those into a real string so trunc() can't throw on .length.
function safeJson(o: unknown): string { try { return JSON.stringify(o) ?? String(o) } catch { return String(o) } }
function trunc(s: string, n: number): string { return s.length > n ? s.slice(0, n) + ' … (+' + (s.length - n) + ' chars)' : s }
