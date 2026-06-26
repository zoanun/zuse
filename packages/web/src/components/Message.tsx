import type { ReactNode } from 'react'
import type { Message as Msg, Part } from '../state/types.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'

export function Message({ msg, onRevert }: { msg: Msg; onRevert?: (checkpointId: string) => void }) {
  if (msg.role === 'system') {
    const kind = msg.noticeKind
    const cls = kind === 'error' ? 'bad' : kind === 'warn' ? 'warn' : 'live'
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return <div className={'note ' + cls}>{text}</div>
  }
  if (msg.role === 'user') {
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    const cp = msg.checkpointId
    return (
      <div className="msg you">
        <div className="bubble">{text}</div>
        {cp && onRevert ? (
          <button
            type="button"
            className="msg-revert"
            title="Revert to this point"
            aria-label="Revert to this point"
            onClick={() => onRevert(cp)}
          >
            <RevertIcon />
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="msg agent">
      <div className="text-wrap">{renderParts(msg.parts)}</div>
    </div>
  )
}

function RevertIcon() {
  // Counterclockwise curved undo/revert arrow.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 7" />
    </svg>
  )
}

function renderParts(parts: Part[]) {
  const out: ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.kind === 'text') out.push(<Markdown key={i} text={p.text} />)
    else if (p.kind === 'tool-use') {
      const next = parts[i + 1]
      const result = next && next.kind === 'tool-result' && next.id === p.id ? next : undefined
      if (result) i++
      if (p.name === 'TodoWrite') continue            // suppressed — shown in the TodosPanel instead
      out.push(<ToolCall key={i} use={p} result={result} />)
    } else if (p.kind === 'tool-result') {
      if (p.name === 'TodoWrite') continue            // orphan TodoWrite result — also suppressed
      out.push(<ToolCall key={i} use={{ kind: 'tool-use', id: p.id, name: p.name || 'tool', input: {} }} result={p} />)
    }
  }
  return out
}
