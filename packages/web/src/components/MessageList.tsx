import { useEffect, useRef } from 'react'
import type { Message as Msg } from '../state/types.js'
import { Message } from './Message.js'

export function MessageList({ messages, thinking }: { messages: Msg[]; thinking: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking])

  return (
    <div className="stream">
      {messages.length === 0 ? <div className="empty">Ask zuse anything to get started.</div> : null}
      {messages.map((m) => <Message key={m.id} msg={m} />)}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
