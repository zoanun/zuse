import { useEffect, useRef } from 'react'
import type { Message as Msg } from '../state/types.js'
import { Message, replyMarkdown } from './Message.js'

export function MessageList({
  messages, thinking, pendingCount = 0, onRevert, onShare, onRetry, shareMode = false, selected, onToggleSelect, scrollToId, onScrolled,
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
  scrollToId?: string | null
  onScrolled?: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking])
  // When a permission card appears, scroll to the bottom so it isn't hidden.
  useEffect(() => { if (pendingCount > 0) endRef.current?.scrollIntoView({ block: 'end' }) }, [pendingCount])

  // When a search hit asks us to jump, scroll its message into view and flash it briefly.
  useEffect(() => {
    if (!scrollToId) return
    const el = document.getElementById('msg-' + scrollToId)
    if (!el) return // 目标不在(会话被截短等):静默跳过
    el.scrollIntoView({ block: 'center' })
    el.classList.add('flash')
    const t = setTimeout(() => el.classList.remove('flash'), 1500)
    onScrolled?.()
    return () => clearTimeout(t)
  }, [scrollToId, messages, onScrolled])

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
            <label key={m.id} id={'msg-' + m.id} className={'msg-row' + (selected?.has(m.id) ? ' sel' : '')}>
              <input
                type="checkbox" className="msg-check" aria-label="Select message"
                checked={selected?.has(m.id) ?? false} onChange={() => onToggleSelect?.(m.id)}
              />
              <div className="msg-row-body">{msgEl}</div>
            </label>
          )
        }
        return <div id={'msg-' + m.id} className="msg-anchor" key={m.id}>{msgEl}</div>
      })}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
