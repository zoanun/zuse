import { memo, type ReactNode } from 'react'
import type { Message as Msg, Part } from '../state/types.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'
import { useCopy } from '../state/useCopy.js'

/** Concatenate the text of all text parts (ignores tool parts). */
export function partsText(parts: Part[]): string {
  return parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
}

/** A turn's prose markdown: text parts joined, with folded `<think>` reasoning stripped out. */
export function replyMarkdown(parts: Part[]): string {
  return splitThink(partsText(parts)).filter((s) => !s.think).map((s) => s.text).join('').trim()
}

// memo: while streaming, the store re-renders on every delta but only the last
// message's identity changes — memo lets the unchanged messages skip re-rendering
// (and re-parsing their markdown). Relies on a stable `onRevert`/`onShare` (see Shell).
export const Message = memo(function Message({ msg, onRevert, onShare, onRetry, shareMode }: {
  msg: Msg
  onRevert?: (checkpointId: string) => void
  onShare?: (id: string) => void
  onRetry?: () => void          // only supplied for the latest assistant reply
  shareMode?: boolean
}) {
  if (msg.role === 'system') {
    const kind = msg.noticeKind
    const cls = kind === 'error' ? 'bad' : kind === 'warn' ? 'warn' : 'live'
    return <div className={'note ' + cls}>{partsText(msg.parts)}</div>
  }
  if (msg.role === 'user') {
    const text = partsText(msg.parts)
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
  const md = replyMarkdown(msg.parts)
  return (
    <div className="msg agent">
      {/* Share mode renders the exact prose export keeps (replyMarkdown) — not a parts filter,
          which would diverge (e.g. leave <think> blocks the export drops). */}
      <div className="text-wrap">{shareMode ? <Markdown text={md} /> : renderParts(msg.parts)}</div>
      {!shareMode && md ? (
        <div className="msg-actions">
          <CopyButton text={md} />
          {onShare ? (
            <MsgAction className="msg-share" title="Share — pick messages to export" label="share" onClick={() => onShare(msg.id)}>
              <ShareIcon />
            </MsgAction>
          ) : null}
          {onRetry ? (
            <MsgAction className="msg-retry" title="Retry — re-run this question from a clean checkpoint" label="retry" onClick={onRetry}>
              <RetryIcon />
            </MsgAction>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** A reply-footer action: icon only; the description lives in the native hover tooltip (title). */
function MsgAction({ className, title, label, onClick, children }: {
  className?: string; title: string; label: string; onClick: () => void; children: ReactNode
}) {
  return (
    <button type="button" className={'msg-copy' + (className ? ' ' + className : '')} title={title} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}

/** Copy a reply's prose markdown to the clipboard; the icon flips to ✓ briefly on success. */
function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopy()
  return (
    <MsgAction title="Copy reply (markdown)" label="Copy reply" onClick={() => copy(text)}>
      {copied ? '✓' : <CopyIcon />}
    </MsgAction>
  )
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 10V2.5M8 2.5 5.8 4.7M8 2.5l2.2 2.2" />
      <path d="M3.5 8.5V12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.5" />
    </svg>
  )
}

function RetryIcon() {
  // Clockwise "redo" arrow.
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z" />
      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
    </svg>
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

/** One slice of assistant text: model reasoning (`think`) vs the actual answer. */
interface TextSeg { think: boolean; text: string }

/**
 * Split assistant text on inline `<think>…</think>` (or `<thinking>…`) blocks that some models
 * emit as literal tags. An unclosed `<think>` (still streaming, or never closed) folds
 * everything after it as reasoning so a runaway loop can't flood the chat.
 */
export function splitThink(text: string): TextSeg[] {
  if (!/<think(?:ing)?>/i.test(text)) return [{ think: false, text }]
  // Each match consumes at least the opening tag, so it always advances — no zero-width guard.
  const re = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi
  const segs: TextSeg[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ think: false, text: text.slice(last, m.index) })
    segs.push({ think: true, text: m[1] ?? '' })
    last = re.lastIndex
  }
  if (last < text.length) segs.push({ think: false, text: text.slice(last) })
  return segs
}

/** Collapsible, dimmed reasoning block (collapsed by default; capped height so it can't flood). */
function ThinkBlock({ text }: { text: string }) {
  if (text.trim() === '') return null
  return (
    <details className="think">
      <summary>💭 thinking</summary>
      <div className="think-body">{text}</div>
    </details>
  )
}

/** Render an assistant text part, folding any `<think>` reasoning into collapsible blocks. */
function AssistantText({ text }: { text: string }) {
  // splitThink fast-returns a single plain segment when there are no tags, so the common
  // (no-think) case is just one <Markdown> — no extra branch needed here.
  return (
    <>
      {splitThink(text).map((s, j) => (s.think
        ? <ThinkBlock key={j} text={s.text} />
        : (s.text.trim() ? <Markdown key={j} text={s.text} /> : null)))}
    </>
  )
}

function renderParts(parts: Part[]) {
  const out: ReactNode[] = []
  // Pair a tool-use with its result BY ID, not by adjacency: the model often batches several
  // calls (all tool_use, then all tool_result), so a use and its result aren't neighbours.
  const resultById = new Map<string, Extract<Part, { kind: 'tool-result' }>>()
  for (const p of parts) if (p.kind === 'tool-result') resultById.set(p.id, p)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.kind === 'text') out.push(<AssistantText key={i} text={p.text} />)
    else if (p.kind === 'tool-use') {
      if (p.name === 'TodoWrite') continue            // suppressed — shown in the TodosPanel instead
      out.push(<ToolCall key={i} use={p} result={resultById.get(p.id)} />)
    } else if (p.kind === 'tool-result') {
      if (p.name === 'TodoWrite') continue            // orphan TodoWrite result — also suppressed
      // Already shown inline with its tool-use above → skip; only truly orphan results render.
      if (parts.some((q) => q.kind === 'tool-use' && q.id === p.id)) continue
      out.push(<ToolCall key={i} use={{ kind: 'tool-use', id: p.id, name: p.name || 'tool', input: {} }} result={p} />)
    }
  }
  return out
}
