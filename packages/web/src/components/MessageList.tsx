import { useEffect, useRef } from 'react'
import type { Message as Msg, Notice } from '../state/types.js'
import { Message } from './Message.js'

export function MessageList({ messages, notices, thinking }: { messages: Msg[]; notices: Notice[]; thinking: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking, notices])

  return (
    <div className="stream">
      {messages.length === 0 && notices.length === 0
        ? <div className="empty">Ask zuse anything to get started.</div>
        : null}
      {messages.map((m) => <Message key={m.id} msg={m} />)}
      {notices.map((n) => <div key={n.id} className={'note ' + (n.kind === 'error' ? 'bad' : n.kind === 'warn' ? 'warn' : 'live')}>{n.text}</div>)}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
