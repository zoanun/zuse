import { useEffect, useRef } from 'react'
import type { Message as Msg } from '../state/types.js'
import { Message, replyMarkdown } from './Message.js'

const EMPTY_SET: ReadonlySet<string> = new Set()

export function MessageList({
  messages, thinking, pendingCount = 0, onRevert, onShare, onRetry, shareMode = false, selected, onToggleSelect,
}: {
  messages: Msg[]
  thinking: boolean
  pendingCount?: number
  onRevert?: (checkpointId: string) => void
  onShare?: (id: string) => void
  onRetry?: () => void
  shareMode?: boolean
  selected?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking])
  // When a permission card appears, scroll to the bottom so it isn't hidden.
  useEffect(() => { if (pendingCount > 0) endRef.current?.scrollIntoView({ block: 'end' }) }, [pendingCount])

  const sel = selected ?? EMPTY_SET
  // Retry lives on the newest assistant reply, but never mid-stream.
  let lastAssistantId: string | undefined
  if (!thinking && !shareMode) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') { lastAssistantId = messages[i]!.id; break }
  }
  // Share mode previews exactly what export keeps: questions + replies with prose; tool-only
  // turns and system notices are hidden so you select among shareable content only.
  const visible = shareMode
    ? messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && replyMarkdown(m.parts) !== ''))
    : messages

  return (
    <div className="stream">
      {messages.length === 0 ? <div className="empty">Ask zuse anything to get started.</div> : null}
      {visible.map((m) => {
        const msgEl = (
          <Message
            key={m.id}
            msg={m}
            onRevert={onRevert}
            onShare={shareMode ? undefined : onShare}
            onRetry={m.id === lastAssistantId ? onRetry : undefined}
            shareMode={shareMode}
          />
        )
        if (shareMode) {
          return (
            <label key={m.id} className={'msg-row' + (sel.has(m.id) ? ' sel' : '')}>
              <input
                type="checkbox" className="msg-check" aria-label="Select message"
                checked={sel.has(m.id)} onChange={() => onToggleSelect?.(m.id)}
              />
              <div className="msg-row-body">{msgEl}</div>
            </label>
          )
        }
        return msgEl
      })}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
