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
  // Circular counterclockwise "restore" arrow (Bootstrap arrow-counterclockwise).
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z" />
      <path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466" />
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
