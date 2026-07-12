import { memo, useState, type ReactNode } from 'react'
import type { MessageAttachment } from '@zuse/protocol'
import type { Message as Msg, Part } from '../state/types.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'
import { useCopy } from '../state/useCopy.js'
import { uploadedImageUrl } from '../state/manageApi.js'
import { ImageLightbox } from './ImageLightbox.js'
import { TextLightbox } from './TextLightbox.js'
import { pastedLineCount, pastedLabel } from './pasted.js'

/** Concatenate the text of all text parts (ignores tool parts). */
export function partsText(parts: Part[]): string {
  return parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
}

// Memoized by the parts-array reference: in share mode MessageList calls replyMarkdown once to
// decide visibility and Message calls it again to render — same `parts` ref within a render, so
// the second call is a WeakMap hit instead of re-splitting <think> + re-joining. A WeakMap keeps
// it leak-free: entries vanish when the parts array (recreated each store update) is GC'd.
const replyMarkdownCache = new WeakMap<Part[], string>()

/** A turn's prose markdown: text parts joined, with folded `<think>` reasoning stripped out. */
export function replyMarkdown(parts: Part[]): string {
  const cached = replyMarkdownCache.get(parts)
  if (cached !== undefined) return cached
  const md = splitThink(partsText(parts)).filter((s) => !s.think).map((s) => s.text).join('').trim()
  replyMarkdownCache.set(parts, md)
  return md
}

/** A shareable/selectable row: a user question, or an assistant reply that has prose (tool-only
 *  replies render nothing and are hidden). Single source of truth for MessageList's share filter
 *  and Shell's turn grouping — keep them from drifting apart. */
export function isSelectableRow(m: Msg): boolean {
  return m.role === 'user' || (m.role === 'assistant' && replyMarkdown(m.parts) !== '')
}

// memo: while streaming, the store re-renders on every delta but only the last
// message's identity changes — memo lets the unchanged messages skip re-rendering
// (and re-parsing their markdown). Relies on a stable `onRevert`/`onShare` (see Shell).
export const Message = memo(function Message({ msg, onRevert, onShare, onRetry, shareMode, showActions = true }: {
  msg: Msg
  onRevert?: (checkpointId: string) => void
  onShare?: (id: string) => void
  onRetry?: () => void          // only supplied for the latest assistant reply
  shareMode?: boolean
  // Whether to render the copy/share/retry footer. MessageList sets this only for a turn's FINAL
  // assistant message, so intermediate replies (model text between tool calls) don't each get a
  // footer mid-turn. Default true keeps standalone use unchanged.
  showActions?: boolean
}) {
  if (msg.role === 'system') {
    const kind = msg.noticeKind
    // Compaction summary: collapsible card, collapsed by default (like a tool/think block) so a
    // long summary doesn't dominate the transcript. Click the head to expand.
    if (kind === 'summary') {
      return (
        <details className="note summary">
          <summary className="summary-head">上下文摘要</summary>
          <div className="summary-body">{partsText(msg.parts)}</div>
        </details>
      )
    }
    // Help: a left-aligned card listing the slash commands (from /help), not a centered one-liner.
    if (kind === 'help') {
      return (
        <div className="note help">
          <div className="help-head">可用命令</div>
          <div className="help-body">{partsText(msg.parts)}</div>
        </div>
      )
    }
    const cls = kind === 'error' ? 'bad' : kind === 'warn' ? 'warn' : 'live'
    return <div className={'note ' + cls}>{partsText(msg.parts)}</div>
  }
  if (msg.role === 'user') {
    const text = partsText(msg.parts)
    const cp = msg.checkpointId
    return (
      <div className="msg you">
        {msg.steer ? <div className="steer-tag" title="回合进行中插入的消息">↪ 插话</div> : null}
        <div className="bubble">
          {msg.attachments?.length ? (
            <div className="msg-imgs">
              {msg.attachments.map((a) => (
                a.route === 'pasted' ? <PastedTextChip key={a.id} a={a} />
                : a.route === 'file' ? <FileChip key={a.id} a={a} />
                : <MessageImage key={a.id} a={a} />
              ))}
            </div>
          ) : null}
          {text}
        </div>
        {cp && onRevert ? (
          <button
            type="button"
            className="msg-revert"
            title="回退到此处"
            aria-label="回退到此处"
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
      {!shareMode && md && showActions ? (
        <div className="msg-actions">
          <CopyButton text={md} />
          {onShare ? (
            <MsgAction className="msg-share" title="分享 — 选择要导出的消息" label="分享" onClick={() => onShare(msg.id)}>
              <ShareIcon />
            </MsgAction>
          ) : null}
          {onRetry ? (
            <MsgAction className="msg-retry" title="重试 — 从干净的检查点重跑此问题" label="重试" onClick={onRetry}>
              <RetryIcon />
            </MsgAction>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** One user-message attachment: thumbnail (links to full image) + route badge + (parsed) the
 *  collapsible description. Extracted from the user branch's attachment map; DOM/classes unchanged. */
function MessageImage({ a }: { a: MessageAttachment }) {
  const url = uploadedImageUrl(a.id)
  const [zoom, setZoom] = useState(false)
  return (
    <div className="msg-img-item">
      <button type="button" className="msg-img-btn" onClick={() => setZoom(true)} aria-label={`查看 ${a.name}`}>
        <img className="msg-img" src={url} alt={a.name} title={a.name} />
      </button>
      {zoom ? <ImageLightbox src={url} alt={a.name} onClose={() => setZoom(false)} /> : null}
      {a.route ? (
        <span className="msg-img-badge">{a.route === 'direct' ? '图·直传' : '图·解析'}</span>
      ) : null}
      {a.route === 'parsed' && a.description ? (
        <details className="msg-img-desc">
          <summary>查看解析</summary>
          <div className="msg-img-desc-body">{a.description}</div>
        </details>
      ) : null}
    </div>
  )
}

/** One pasted-text attachment: a folded card (📄 粘贴文本 #N (+M 行)) that opens the full text in
 *  a TextLightbox on click. Full text comes from the persisted attachment.text, so it renders the same
 *  live and after reload. */
function PastedTextChip({ a }: { a: MessageAttachment }) {
  const [open, setOpen] = useState(false)
  const label = pastedLabel(a.name, pastedLineCount(a.text ?? ''))
  return (
    <div className="paste-card">
      <button type="button" className="paste-card-btn" onClick={() => setOpen(true)} aria-label={`查看 ${a.name}`}>
        <span className="paste-card-icon" aria-hidden="true">📄</span>
        <span className="paste-card-label">{label}</span>
      </button>
      {open ? <TextLightbox text={a.text ?? ''} title={a.name} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/** One uploaded-file attachment: a folded 📎 card (name only). No preview — the file lives on the
 *  server and the model reads it via tools; there's no generic client-side viewer. */
function FileChip({ a }: { a: MessageAttachment }) {
  return (
    <div className="paste-card" title={a.name}>
      <span className="paste-card-icon" aria-hidden="true">📎</span>
      <span className="paste-card-label">{a.name}</span>
    </div>
  )
}

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
    <MsgAction title="复制回复（markdown）" label="复制回复" onClick={() => copy(text)}>
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
  const hasOpen = /<think(?:ing)?>/i.test(text)
  // Some models (e.g. reasoning models via certain endpoints) stream the reasoning as plain
  // content and emit ONLY a bare closing </think> before the answer — no opening tag. Fold
  // everything up to that first lone </think> as reasoning so the tag never leaks into the answer.
  if (!hasOpen) {
    const close = text.match(/<\/think(?:ing)?>/i)
    if (!close || close.index === undefined) return [{ think: false, text }]
    // Guard against folding away real answer text: if a ``` code fence appears BEFORE the first
    // lone </think>, treat the whole thing as literal prose (the tag is being shown/discussed inside
    // a fenced code block, not emitted as a reasoning boundary). Otherwise a reply that merely quotes
    // </think> in a code block would silently lose everything above it into hidden reasoning.
    // (A naked </think> discussed in prose WITHOUT any fence is the rare accepted limitation.)
    const before = text.slice(0, close.index)
    if (before.includes('```')) return [{ think: false, text }]
    const segs: TextSeg[] = [{ think: true, text: text.slice(0, close.index) }]
    const rest = text.slice(close.index + close[0].length)
    if (rest) segs.push(...splitThink(rest)) // remainder may contain further tags
    return segs
  }
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
      <summary>💭 思考</summary>
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
