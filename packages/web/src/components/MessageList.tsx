import { useEffect, useRef } from 'react'
import type { Message as Msg } from '../state/types.js'
import { Message } from './Message.js'

export function MessageList({ messages, thinking, pendingCount = 0, onRevert }: {
  messages: Msg[]
  thinking: boolean
  pendingCount?: number
  onRevert?: (checkpointId: string) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking])
  // When a permission card appears, scroll to the bottom so it isn't hidden.
  useEffect(() => { if (pendingCount > 0) endRef.current?.scrollIntoView({ block: 'end' }) }, [pendingCount])

  return (
    <div className="stream">
      {messages.length === 0 ? <div className="empty">Ask zuse anything to get started.</div> : null}
      {messages.map((m) => <Message key={m.id} msg={m} onRevert={onRevert} />)}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
