import type { ReactNode } from 'react'
import type { Message as Msg, Part } from '../state/types.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'

export function Message({ msg }: { msg: Msg }) {
  if (msg.role === 'user') {
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return <div className="msg you"><div className="bubble">{text}</div></div>
  }
  return (
    <div className="msg agent">
      <div className="text-wrap">{renderParts(msg.parts)}</div>
    </div>
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
      out.push(<ToolCall key={i} use={p} result={result} />)
    } else if (p.kind === 'tool-result') {
      out.push(<ToolCall key={i} use={{ kind: 'tool-use', id: p.id, name: 'tool', input: {} }} result={p} />)
    }
  }
  return out
}
