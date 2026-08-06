import { useEffect, useMemo, useRef } from 'react'
import type { Message as Msg } from '../state/types.js'
import { Message, isSelectableRow } from './Message.js'

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

  // When a search hit asks us to jump, scroll its message into view and flash it. The 1.5s CSS
  // `msg-flash` animation self-terminates, so no JS timer is needed to end it. (onScrolled clears
  // the pending target after the first successful scroll.)
  useEffect(() => {
    if (!scrollToId) return
    const el = document.getElementById('msg-' + scrollToId)
    if (!el) return // 目标不在(索引不匹配/会话被截短等):静默跳过
    // Align the message's TOP to the viewport top (not centered) so a long message's start is
    // visible instead of landing mid-content.
    el.scrollIntoView({ block: 'start' })
    // Restart the one-shot flash even when the class lingers from a prior jump to the SAME
    // message: remove → force reflow → re-add. (A bare add() is a no-op if the class is already
    // present, so the animation wouldn't replay on a repeat click.)
    el.classList.remove('flash')
    void (el as HTMLElement).offsetWidth
    el.classList.add('flash')
    onScrolled?.()
  }, [scrollToId, messages, onScrolled])

  // Retry lives on the newest assistant reply, but never mid-stream.
  let lastAssistantId: string | undefined
  if (!thinking && !shareMode) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') { lastAssistantId = messages[i]!.id; break }
  }
  // 流式中的那条 = thinking 为真时的最后一条 assistant 消息。代码预览的「运行」按钮据此
  // 禁用：`CodeBlock` 自己无法判断围栏是否已闭合（未闭合的围栏渲染出的 <pre> 结构完全相同），
  // 没有这个信号，模型刚吐出半个组件时按钮就可点了。
  let streamingId: string | undefined
  if (thinking && !shareMode) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') { streamingId = messages[i]!.id; break }
  }
  // A turn is a run of consecutive assistant messages (tool-result user turns are folded away by
  // foldToolResults). Show the copy/share footer only on each turn's LAST assistant message — the
  // one whose next message isn't another assistant — so the model's between-tool prose doesn't
  // sprout a footer mid-turn. (Retry is already restricted to the single newest reply above.)
  // A mid-turn steer bubble (role:'user', steer:true) is an interjection, not a turn boundary, so
  // look PAST any steer bubbles when deciding what follows an assistant message: it's turn-final
  // iff the next non-steer message isn't another assistant (or there is none). Checking only the
  // immediate neighbour would both (a) footer the reply before an inserted steer, and (b) FAIL to
  // footer the final reply when a steer is the very last message in the stream.
  // Memoized on `messages` so it isn't rebuilt on scroll/thinking-only re-renders.
  const turnFinalIds = useMemo(() => {
    const ids = new Set<string>()
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role !== 'assistant') continue
      let j = i + 1
      while (j < messages.length && messages[j]!.steer) j++ // skip interjected steer bubbles
      const next = messages[j]
      if (!next || next.role !== 'assistant') ids.add(messages[i]!.id)
    }
    return ids
  }, [messages])
  // Share mode previews exactly what export keeps: questions + replies with prose; tool-only
  // turns and system notices are hidden so you select among shareable content only.
  const visible = shareMode ? messages.filter(isSelectableRow) : messages

  return (
    <div className="stream">
      {messages.length === 0 ? <div className="empty">输入任意内容，开始和 zuse 对话</div> : null}
      {visible.map((m) => {
        const msgEl = (
          <Message
            key={m.id}
            msg={m}
            onRevert={onRevert}
            onShare={shareMode ? undefined : onShare}
            onRetry={m.id === lastAssistantId ? onRetry : undefined}
            shareMode={shareMode}
            showActions={turnFinalIds.has(m.id)}
            streaming={m.id === streamingId}
          />
        )
        if (shareMode) {
          return (
            <label key={m.id} id={'msg-' + m.id} className={'msg-row' + (selected?.has(m.id) ? ' sel' : '')}>
              <input
                type="checkbox" className="msg-check" aria-label="选择消息"
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
