import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { UploadedImageRef, PastedTextInput } from '@zuse/protocol'
import { pastedLineCount } from './pasted.js'
import type { SlashCommand } from './commands.js'
import { filterCommands } from './commands.js'
import { uploadImage, uploadedImageUrl } from '../state/manageApi.js'
import { ImageLightbox } from './ImageLightbox.js'
import { TextLightbox } from './TextLightbox.js'

interface ComposerProps {
  thinking: boolean
  onSend: (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[]) => void
  onStop: () => void
  history?: string[]
  commands?: SlashCommand[]
  onRunCommand?: (cmd: SlashCommand) => void
}

/** A locally-staged image: created on paste/drop/pick, uploaded async, sent (as `ref`) on submit. */
interface PendingImage {
  key: string
  name: string
  status: 'uploading' | 'done' | 'error'
  ref?: UploadedImageRef
  previewUrl?: string
  /** The original File, retained so retry re-uploads the exact bytes (no blob refetch). */
  file: File
}

/** A locally-staged pasted-text segment: shown as a card, sent inline on submit. */
interface PendingPaste { id: string; text: string }

const MAX_IMAGES = 10
const MAX_BYTES = 25 * 1024 * 1024
const PASTE_CHAR_THRESHOLD = 800
const PASTE_NEWLINE_THRESHOLD = 2

/** Imperative surface so a whole-page drop zone (Shell) can hand dropped image files to the composer. */
export interface ComposerHandle { addImages: (files: File[]) => void }

/** Pull image Files out of a paste/drop payload — files first, then items (kind==='file', image/*). */
export function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const f of Array.from(dt.files ?? [])) if (f && f.type.startsWith('image/')) out.push(f)
  if (out.length === 0 && dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  return out
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ thinking, onSend, onStop, history = [], commands = [], onRunCommand }, ref) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Esc dismisses the menu even though input still starts with '/'. Cleared whenever the input changes.
  const [menuDismissed, setMenuDismissed] = useState(false)
  // Command menu: candidate list derived from current input + a highlighted index.
  const menu = filterCommands(value, commands)
  const menuOpen = menu.length > 0 && !menuDismissed
  const [menuIdx, setMenuIdx] = useState(0)
  // History cursor: null = editing a fresh draft; otherwise an index into `history` (0 = oldest).
  const [histIdx, setHistIdx] = useState<number | null>(null)
  // Staged images awaiting send + an inline attach-error line (size/count/upload feedback).
  const [pending, setPending] = useState<PendingImage[]>([])
  const [pastes, setPastes] = useState<PendingPaste[]>([])
  const pasteSeqRef = useRef(0)
  const [attachError, setAttachError] = useState('')
  const keySeq = useRef(0)
  // Staged-attachment preview (image lightbox or full-text lightbox), opened by clicking a tray item.
  const [preview, setPreview] = useState<
    { kind: 'image'; src: string; alt: string } | { kind: 'text'; text: string; title: string } | null
  >(null)

  useEffect(() => { taRef.current?.focus() }, [])
  useEffect(() => { if (!thinking) taRef.current?.focus() }, [thinking])
  // Attach errors (over-size / over-count / upload feedback) are transient notices — auto-dismiss
  // after a few seconds so they don't linger. Re-arms whenever the message changes.
  useEffect(() => {
    if (!attachError) return
    const t = setTimeout(() => setAttachError(''), 4000)
    return () => clearTimeout(t)
  }, [attachError])
  // New session → fresh history array → reset the cursor.
  useEffect(() => { setHistIdx(null) }, [history])
  // Keep the highlight in range as the candidate list shrinks/grows.
  useEffect(() => { setMenuIdx(0) }, [value])
  // Auto-size the textarea AFTER the value commits to the DOM — measuring scrollHeight in the change
  // handler would read the pre-update value for a programmatic setValue (history recall / command
  // clear), sizing the box to the previous content. useLayoutEffect runs post-commit, pre-paint.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 168) + 'px'
  }, [value])

  // Revoke every outstanding object-URL on unmount so instant-preview blobs don't leak.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => () => {
    for (const p of pendingRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
  }, [])

  // Stage + upload a batch of picked images. Only stores images (no model/parse checks here — the
  // "model can't read images" error surfaces on send, from the server, as a chat error event).
  function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const errors: string[] = []
    const sized = images.filter((f) => {
      if (f.size > MAX_BYTES) { errors.push(`${f.name} 超过 25MB，已跳过`); return false }
      return true
    })
    const room = Math.max(0, MAX_IMAGES - pending.length)
    let batch = sized
    if (sized.length > room) {
      batch = sized.slice(0, room)
      errors.push(`最多 ${MAX_IMAGES} 张图片`)
    }
    setAttachError(errors.join('；'))
    for (const file of batch) {
      const key = 'img-' + ++keySeq.current
      const previewUrl = URL.createObjectURL(file)
      setPending((p) => [...p, { key, name: file.name, status: 'uploading', previewUrl, file }])
      uploadInto(key, file)
    }
  }

  /** Upload `file`, mapping the result onto the pending row `key` (done+ref / error). Shared by
   *  the initial stage (addFiles) and retry, so both take the same success/failure path. */
  function uploadInto(key: string, file: File) {
    uploadImage(file).then(
      (ref) => setPending((p) => p.map((it) => (it.key === key ? { ...it, status: 'done', ref } : it))),
      () => setPending((p) => p.map((it) => (it.key === key ? { ...it, status: 'error' } : it))),
    )
  }

  function removePending(key: string) {
    setPending((p) => {
      const item = p.find((it) => it.key === key)
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return p.filter((it) => it.key !== key)
    })
  }

  function retry(key: string) {
    const item = pendingRef.current.find((it) => it.key === key)
    if (!item) return
    setPending((p) => p.map((it) => (it.key === key ? { ...it, status: 'uploading' as const } : it)))
    uploadInto(key, item.file) // re-upload the retained File — no blob refetch
  }

  // Stage image files (from paste, or from the whole-page drop zone via the imperative handle):
  // bail if none, refuse mid-turn, else upload. Callers that own a DOM event preventDefault first.
  function stage(files: File[]) {
    if (files.length === 0) return
    addFiles(files)
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesFrom(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault() // don't also paste the image as a data-URL string
      stage(files)
      return
    }
    // Long-text paste → card (CC threshold: >800 chars OR >2 newlines). Shorter paste: let it through.
    const raw = e.clipboardData.getData('text') || e.clipboardData.getData('text/plain')
    if (!raw) return
    const text = raw.replace(/\r\n?/g, '\n') // normalize \r\n and lone \r → \n
    if (text.length > PASTE_CHAR_THRESHOLD || pastedLineCount(text) > PASTE_NEWLINE_THRESHOLD) {
      e.preventDefault()
      // Mid-turn interjection (steer) now carries attachments too — the server queues them and
      // delivers as a follow-up turn, so staging while thinking is allowed here.
      const id = `pasted-${pasteSeqRef.current++}`
      setPastes((prev) => [...prev, { id, text }])
    }
    // else: no preventDefault → browser inserts it into the textarea normally.
  }

  // Shell hosts a whole-page drop zone and forwards dropped image files here (recreated each render
  // so `stage` closes over the current `thinking`/`pending`).
  useImperativeHandle(ref, () => ({ addImages: stage }))

  const uploading = pending.some((p) => p.status === 'uploading')
  const doneRefs = pending.filter((p) => p.status === 'done' && p.ref).map((p) => p.ref!)
  const canSend = (value.trim() !== '' || doneRefs.length > 0 || pastes.length > 0) && !uploading

  function clearPending() {
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    setPending([])
    setPastes([])
    setAttachError('')
  }

  function removePaste(id: string) { setPastes((prev) => prev.filter((p) => p.id !== id)) }

  function submit() {
    if (uploading) { setAttachError('图片上传中，请稍候'); return }
    const v = value.trim()
    if (!v && doneRefs.length === 0 && pastes.length === 0) return
    const images = doneRefs.length ? doneRefs : undefined
    // Sending is allowed even while `thinking`: Shell routes it to a mid-turn steer.
    // Omit the pastedTexts arg entirely when there are none, rather than passing `undefined` —
    // callers/tests that assert onSend's exact arg list shouldn't see a phantom 3rd argument.
    if (pastes.length) onSend(v, images, pastes.map((p) => ({ id: p.id, text: p.text })))
    else onSend(v, images)
    clearPending()
    setValue(''); setHistIdx(null)
    taRef.current?.focus()
  }

  function runCommand(cmd: SlashCommand) {
    onRunCommand?.(cmd)
    setValue(''); setHistIdx(null)
    taRef.current?.focus()
  }

  const draftRef = useRef('')
  function recallPrev() {
    if (history.length === 0) return
    const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
    if (histIdx === null) draftRef.current = value // entering history: stash the draft
    setHistIdx(next); setValue(history[next]!)
  }
  function recallNext() {
    if (histIdx === null) return
    const next = histIdx + 1
    if (next >= history.length) { setHistIdx(null); setValue(draftRef.current); return } // back to draft
    setHistIdx(next); setValue(history[next]!)
  }

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <ul className="slash-menu" role="listbox" aria-label="命令">
          {menu.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === menuIdx}
              className={'slash-item' + (i === menuIdx ? ' active' : '')}
              onMouseDown={(e) => e.preventDefault()} // keep textarea focus; run on click
              onClick={() => runCommand(c)}
            >
              <span className="slash-name">{c.name}</span>
              <span className="slash-desc">{c.desc}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pending.length > 0 ? (
        <div className="attach-tray">
          {pending.map((p) => (
            <div key={p.key} className={'attach-thumb' + (p.status === 'error' ? ' error' : '') + (p.status === 'uploading' ? ' uploading' : '')}>
              <button
                type="button"
                className="attach-thumb-btn"
                aria-label={`查看 ${p.name}`}
                onClick={() => setPreview({ kind: 'image', src: p.previewUrl ?? (p.ref ? uploadedImageUrl(p.ref.id) : ''), alt: p.name })}
              >
                <img src={p.previewUrl ?? (p.ref ? uploadedImageUrl(p.ref.id) : '')} alt={p.name} />
              </button>
              {p.status === 'uploading' ? <span className="attach-spinner" aria-label="上传中" /> : null}
              {p.status === 'error' ? (
                <button className="attach-retry" aria-label={`重试 ${p.name}`} onClick={() => retry(p.key)}>↻</button>
              ) : null}
              <button className="attach-remove" aria-label={`移除 ${p.name}`} onClick={() => removePending(p.key)}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {pastes.length > 0 ? (
        <div className="attach-tray">
          {pastes.map((p, i) => {
            const m = pastedLineCount(p.text)
            const label = m === 0 ? `粘贴文本 #${i + 1}` : `粘贴文本 #${i + 1} (+${m} 行)`
            return (
              <div key={p.id} className="paste-card" title={label}>
                <button
                  type="button"
                  className="paste-card-btn"
                  aria-label={`查看 粘贴文本 #${i + 1}`}
                  onClick={() => setPreview({ kind: 'text', text: p.text, title: `粘贴文本 #${i + 1}` })}
                >
                  <span className="paste-card-icon" aria-hidden="true">📄</span>
                  <span className="paste-card-label">{label}</span>
                </button>
                <button className="attach-remove" aria-label={`移除 粘贴文本 #${i + 1}`} onClick={() => removePaste(p.id)}>×</button>
              </div>
            )
          })}
        </div>
      ) : null}
      {attachError ? <div className="attach-error" role="alert">{attachError}</div> : null}
      <div className="composer">
        <button
          className="attach-btn"
          aria-label="添加图片"
          onClick={() => fileRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }}
        />
        <textarea
          ref={taRef}
          rows={1}
          placeholder={thinking ? '插入消息到当前回合…' : '给 zuse 发消息…'}
          value={value}
          onPaste={onPaste}
          onChange={(e) => { setValue(e.target.value); setHistIdx(null); setMenuDismissed(false) }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            // 1) Command menu open: arrows/enter/tab/esc drive the menu. Shift+Enter still inserts a
            //    newline; only plain Enter (or Tab) runs the highlighted command. menuIdx can lag one
            //    render behind a list that just shrank, so fall back to the first item, never undefined.
            if (menuOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % menu.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + menu.length) % menu.length); return }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); runCommand(menu[menuIdx] ?? menu[0]!); return }
              if (e.key === 'Escape') { e.preventDefault(); setMenuDismissed(true); return }
            }
            // 2) Menu closed: Enter sends.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return }
            // 3) Menu closed: ArrowUp/Down recall input history — but only for SINGLE-LINE input (a
            //    multi-line draft keeps normal caret movement, so an in-progress draft is never
            //    hijacked), and only when there's somewhere to go (else the arrow stays a live caret
            //    key instead of becoming dead).
            if (!value.startsWith('/') && !value.includes('\n')) {
              if (e.key === 'ArrowUp' && history.length > 0) { e.preventDefault(); recallPrev(); return }
              if (e.key === 'ArrowDown' && histIdx !== null) { e.preventDefault(); recallNext(); return }
            }
            // 4) Menu closed: Escape stops the turn if one is running.
            if (e.key === 'Escape' && thinking) { e.preventDefault(); onStop(); return }
          }}
        />
        {thinking ? (
          <button className="stop-btn" aria-label="停止" onClick={onStop}>
            <svg viewBox="0 0 15 15" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="9" height="9" rx="2.5" /></svg>
          </button>
        ) : null}
        <button className="send-btn" aria-label="发送消息" disabled={!canSend} onClick={submit}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 10 4 15 9 20" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </svg>
        </button>
      </div>
      {preview?.kind === 'image' ? <ImageLightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} /> : null}
      {preview?.kind === 'text' ? <TextLightbox text={preview.text} title={preview.title} onClose={() => setPreview(null)} /> : null}
    </div>
  )
})
