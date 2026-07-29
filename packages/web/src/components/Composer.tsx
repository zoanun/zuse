import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { UploadedImageRef, PastedTextInput, UploadedFileRef } from '@zuse/protocol'
import { pastedLineCount, pastedLabel } from './pasted.js'
import type { SlashCommand } from './commands.js'
import { filterCommands } from './commands.js'
import { uploadImage, uploadedImageUrl, uploadFile } from '../state/manageApi.js'
import { transcribe } from '../state/voiceApi.js'
import { useVoice } from '../state/store.js'
import { ImageLightbox } from './ImageLightbox.js'
import { TextLightbox } from './TextLightbox.js'

interface ComposerProps {
  thinking: boolean
  onSend: (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]) => void
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

/** A locally-staged pasted-text segment: shown as a card, sent inline on submit. `lines` is the
 *  newline count computed once at paste time (for the "+M 行" label — avoids rescanning the full
 *  text on every composer re-render). */
interface PendingPaste { id: string; text: string; lines: number }

/** A locally-staged non-image file: uploaded async, sent (as ref) on submit. */
interface PendingFile {
  key: string
  name: string
  status: 'uploading' | 'done' | 'error'
  ref?: UploadedFileRef
  /** The original File, retained so retry re-uploads the exact bytes (no blob refetch). */
  file: File
}

const MAX_IMAGES = 10
const MAX_BYTES = 25 * 1024 * 1024
/** 单次录音硬上限（V1）：误按一次也只会产出两分钟音频，撞不到服务端 25 MiB 的 body cap。 */
const MAX_RECORD_MS = 2 * 60 * 1000
const FILE_MAX_BYTES = 50 * 1024 * 1024 // matches server FILE_MAX_BYTES
const PASTE_CHAR_THRESHOLD = 800
const PASTE_NEWLINE_THRESHOLD = 2

/** Imperative surface so a whole-page drop zone (Shell) can hand dropped image/other files to the composer. */
export interface ComposerHandle { addImages: (files: File[]) => void; addFiles: (files: File[]) => void; restoreInput: (text: string) => void }

/** Pull Files out of a paste/drop payload — files first, then items (kind==='file') — keeping only
 *  those whose mediaType satisfies `pred`. Shared body of imageFilesFrom / otherFilesFrom. */
function filesFrom(dt: DataTransfer | null | undefined, pred: (type: string) => boolean): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const f of Array.from(dt.files ?? [])) if (f && pred(f.type)) out.push(f)
  if (out.length === 0 && dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file' && pred(it.type)) {
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  return out
}

/** Image files from a paste/drop payload. */
export function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  return filesFrom(dt, (t) => t.startsWith('image/'))
}

/** Non-image files from a paste/drop payload (files imageFilesFrom would NOT take). */
export function otherFilesFrom(dt: DataTransfer | null | undefined): File[] {
  return filesFrom(dt, (t) => !t.startsWith('image/'))
}

/** 录音计时的 m:ss 展示。 */
function formatElapsed(sec: number): string {
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
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
  const [files, setFiles] = useState<PendingFile[]>([])
  const pasteSeqRef = useRef(0)
  const [attachError, setAttachError] = useState('')
  const keySeq = useRef(0)
  // Staged-attachment preview (image lightbox or full-text lightbox), opened by clicking a tray item.
  const [preview, setPreview] = useState<
    { kind: 'image'; src: string; alt: string } | { kind: 'text'; text: string; title: string } | null
  >(null)
  // V1 语音输入。能力来自 store 的一次性 GET /api/voice 探测；录音器/音轨挂在 ref 上，因为
  // 录音→停止→转写这条链跨了好几次渲染。
  const { caps } = useVoice()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // 转写文本插入后光标该落的位置（受控 textarea：只能在 DOM 提交后再设，见下方 useLayoutEffect）。
  const caretRef = useRef<number | null>(null)
  // 转写在若干次渲染之后才回来，闭包里的 `value` 早过期了 —— 插入时读这个 ref 的当下值。
  const valueRef = useRef(value)
  valueRef.current = value

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

  // 录音中：每秒走一格计时，并挂一个 2 分钟的硬停。硬停走 stopRecording()（即 MediaRecorder.stop()），
  // 与手动停止是同一条收尾路径（onstop → 转写），不另开一套。
  useEffect(() => {
    if (!recording) return
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000)
    const hard = setTimeout(() => stopRecording(), MAX_RECORD_MS)
    return () => { clearInterval(tick); clearTimeout(hard) }
  }, [recording])

  // 卸载兜底：松开麦克风音轨，别把浏览器的录音指示灯留在亮着的状态。
  useEffect(() => () => releaseStream(), [])

  // 插入转写文本后把光标放回插入点之后：受控 textarea 的 value 一提交，浏览器会把光标推到末尾，
  // 所以要在 commit 之后（useLayoutEffect，pre-paint）再设一次，避免闪一下。
  useLayoutEffect(() => {
    const pos = caretRef.current
    if (pos === null) return
    caretRef.current = null
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(pos, pos)
  }, [value])

  // Revoke every outstanding object-URL on unmount so instant-preview blobs don't leak.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => () => {
    for (const p of pendingRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
  }, [])

  // Stage + upload a batch of picked images. Only stores images (no model/parse checks here — the
  // "model can't read images" error surfaces on send, from the server, as a chat error event).
  // NB: images-only — distinct from stageFiles() (non-image files) and the handle's addFiles.
  function addImageFiles(files: File[]) {
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
    addImageFiles(files)
  }

  // Stage + upload a batch of picked non-image files (attachments sent as `files` on submit).
  function stageFiles(picked: File[]) {
    for (const file of picked) {
      if (file.size > FILE_MAX_BYTES) {
        setAttachError(`${file.name} 超过 50MB，已跳过`)
        continue
      }
      if (file.type === '' && file.size === 0) {
        setAttachError(`无法上传「${file.name}」（可能是文件夹或空文件）`)
        continue
      }
      const key = 'file-' + ++keySeq.current
      setFiles((p) => [...p, { key, name: file.name, status: 'uploading', file }])
      uploadFileInto(key, file)
    }
  }

  /** Upload `file`, mapping the result onto the pending file row `key` (done+ref / error). Shared
   *  by the initial stage (stageFiles) and retryFile, so both take the same success/failure path. */
  function uploadFileInto(key: string, file: File) {
    uploadFile(file).then(
      (ref) => setFiles((p) => p.map((it) => (it.key === key ? { ...it, status: 'done', ref } : it))),
      () => setFiles((p) => p.map((it) => (it.key === key ? { ...it, status: 'error' } : it))),
    )
  }

  function retryFile(key: string) {
    const item = files.find((f) => f.key === key)
    if (!item) return
    setFiles((p) => p.map((it) => (it.key === key ? { ...it, status: 'uploading' as const } : it)))
    uploadFileInto(key, item.file)
  }

  function removeFile(key: string) { setFiles((p) => p.filter((it) => it.key !== key)) }

  /** 松开麦克风音轨并丢弃录音器。多次调用安全（停止 / 失败 / 卸载三条路径共用）。 */
  function releaseStream() {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop()
    streamRef.current = null
    recRef.current = null
  }

  /** 开录：拿麦克风 → MediaRecorder。任何一步失败（拒权限、无 MediaRecorder）都只是一行红字。 */
  async function startRecording() {
    if (recording || transcribing) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        releaseStream()
        setRecording(false)
        const blob = new Blob(chunks, { type })
        if (blob.size > 0) void runTranscribe(blob)
      }
      recRef.current = rec
      rec.start()
      setElapsed(0)
      setRecording(true)
    } catch {
      releaseStream()
      setRecording(false)
      setAttachError('无法开始录音（麦克风被拒绝或不可用）')
    }
  }

  /** 停录。真正的收尾在 onstop 里，所以这里只负责触发它；录音器已经没了就直接清干净。 */
  function stopRecording() {
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') { rec.stop(); return }
    releaseStream()
    setRecording(false)
  }

  /** 录音 Blob → /api/voice/stt → 插入光标处。失败只提示，不丢用户已经打的字。 */
  async function runTranscribe(blob: Blob) {
    setTranscribing(true)
    try {
      const text = await transcribe(blob)
      if (text.trim()) insertAtCursor(text)
    } catch {
      setAttachError('转写失败，请重试')
    } finally {
      setTranscribing(false)
    }
  }

  /** 把文本插进当前光标处（有选区则替换选区）：不覆盖已有内容，也绝不自动发送。 */
  function insertAtCursor(text: string) {
    const ta = taRef.current
    const cur = valueRef.current
    const start = ta?.selectionStart ?? cur.length
    const end = ta?.selectionEnd ?? cur.length
    caretRef.current = start + text.length
    setValue(cur.slice(0, start) + text + cur.slice(end))
    setHistIdx(null)
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesFrom(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault() // don't also paste the image as a data-URL string
      stage(files)
      return
    }
    const otherFiles = otherFilesFrom(e.clipboardData)
    if (otherFiles.length > 0) {
      e.preventDefault()
      stageFiles(otherFiles)
      return
    }
    // Long-text paste → card (CC threshold: >800 chars OR >2 newlines). Shorter paste: let it through.
    const raw = e.clipboardData.getData('text') || e.clipboardData.getData('text/plain')
    if (!raw) return
    const text = raw.replace(/\r\n?/g, '\n') // normalize \r\n and lone \r → \n
    const lines = pastedLineCount(text)
    if (text.length > PASTE_CHAR_THRESHOLD || lines > PASTE_NEWLINE_THRESHOLD) {
      e.preventDefault()
      // Mid-turn interjection (steer) now carries attachments too — the server queues them and
      // delivers as a follow-up turn, so staging while thinking is allowed here.
      const id = `pasted-${pasteSeqRef.current++}`
      setPastes((prev) => [...prev, { id, text, lines }])
    }
    // else: no preventDefault → browser inserts it into the textarea normally.
  }

  // Textarea drop target: image files → stage (uploadImage), other files → stageFiles (uploadFile).
  // Mirrors Shell's whole-page drop zone for drops that land directly on the input.
  function onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    e.stopPropagation() // don't also let Shell's whole-page drop zone stage this same drop again
    const imgs = imageFilesFrom(e.dataTransfer)
    const others = otherFilesFrom(e.dataTransfer)
    if (imgs.length) stage(imgs)
    if (others.length) stageFiles(others)
  }

  // Shell hosts a whole-page drop zone and forwards dropped image/other files here (recreated each
  // render so `stage`/`stageFiles` close over the current `thinking`/`pending`/`files`).
  useImperativeHandle(ref, () => ({
    addImages: stage,
    addFiles: stageFiles,
    restoreInput: (text: string) => {
      setValue((cur) => (cur.trim() === '' ? text : cur))
      taRef.current?.focus()
    },
  }))

  const uploading = pending.some((p) => p.status === 'uploading')
  const doneRefs = pending.filter((p) => p.status === 'done' && p.ref).map((p) => p.ref!)
  const uploadingFiles = files.some((f) => f.status === 'uploading')
  const doneFileRefs = files.filter((f) => f.status === 'done' && f.ref).map((f) => f.ref!)
  // 录音中/转写中禁止发送：文本还没落进输入框就发出去，等于把这一段录音扔了。
  const canSend = (value.trim() !== '' || doneRefs.length > 0 || pastes.length > 0 || doneFileRefs.length > 0) && !uploading && !uploadingFiles && !recording && !transcribing
  // getUserMedia 在非 secure context 下压根不存在（局域网明文 http 访问就是这样）→ 按钮自动消失，
  // 不是报错。恢复办法见 docs/remote-access.md（TLS / 隧道）。
  const canRecord = caps?.stt === true && typeof navigator.mediaDevices?.getUserMedia === 'function'

  function clearPending() {
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    setPending([])
    setPastes([])
    setFiles([])
    setAttachError('')
  }

  function removePaste(id: string) { setPastes((prev) => prev.filter((p) => p.id !== id)) }

  function submit() {
    if (uploading || uploadingFiles) { setAttachError('附件上传中，请稍候'); return }
    if (files.some((f) => f.status === 'error')) { setAttachError('有附件上传失败，请重试或移除'); return }
    const v = value.trim()
    if (!v && doneRefs.length === 0 && pastes.length === 0 && doneFileRefs.length === 0) return
    const images = doneRefs.length ? doneRefs : undefined
    const attachFiles = doneFileRefs.length ? doneFileRefs : undefined
    // Sending is allowed even while `thinking`: Shell routes it to a mid-turn steer.
    // Omit the pastedTexts/files args entirely when there are none, rather than passing `undefined` —
    // callers/tests that assert onSend's exact arg list shouldn't see a phantom trailing argument.
    if (pastes.length && attachFiles) onSend(v, images, pastes.map((p) => ({ id: p.id, text: p.text })), attachFiles)
    else if (pastes.length) onSend(v, images, pastes.map((p) => ({ id: p.id, text: p.text })))
    else if (attachFiles) onSend(v, images, undefined, attachFiles)
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
            const base = `粘贴文本 #${i + 1}`
            return (
              <div key={p.id} className="paste-card" title={pastedLabel(base, p.lines)}>
                <button
                  type="button"
                  className="paste-card-btn"
                  aria-label={`查看 ${base}`}
                  onClick={() => setPreview({ kind: 'text', text: p.text, title: base })}
                >
                  <span className="paste-card-icon" aria-hidden="true">📄</span>
                  <span className="paste-card-label">{pastedLabel(base, p.lines)}</span>
                </button>
                <button className="attach-remove" aria-label={`移除 ${base}`} onClick={() => removePaste(p.id)}>×</button>
              </div>
            )
          })}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="attach-tray">
          {files.map((f) => (
            <div key={f.key} className={'paste-card' + (f.status === 'error' ? ' error' : '')} title={f.name}>
              <span className="paste-card-icon" aria-hidden="true">📎</span>
              <span className="paste-card-label">{f.name}{f.status === 'uploading' ? ' …' : ''}{f.status === 'error' ? ' (失败)' : ''}</span>
              {f.status === 'error' ? (
                <button className="attach-retry" aria-label={`重试 ${f.name}`} onClick={() => retryFile(f.key)}>↻</button>
              ) : null}
              <button className="attach-remove" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.key)}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {attachError ? <div className="attach-error" role="alert">{attachError}</div> : null}
      <div className="composer">
        <button
          className="attach-btn"
          aria-label="添加附件"
          onClick={() => fileRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            const imgs = picked.filter((f) => f.type.startsWith('image/'))
            const others = picked.filter((f) => !f.type.startsWith('image/'))
            if (imgs.length) addImageFiles(imgs)
            if (others.length) stageFiles(others)
            e.target.value = ''
          }}
        />
        {canRecord ? (
          <button
            type="button"
            className={'mic-btn' + (recording ? ' recording' : '')}
            aria-label={recording ? '停止录音' : '语音输入'}
            title={recording ? '停止录音并转写' : '语音输入 — 录一段，转写后填进输入框'}
            disabled={transcribing}
            onClick={() => (recording ? stopRecording() : void startRecording())}
          >
            <MicIcon />
            {recording ? <span className="mic-timer">{formatElapsed(elapsed)}</span> : null}
            {transcribing ? <span className="mic-timer">转写中…</span> : null}
          </button>
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={thinking ? '插入消息到当前回合…' : '给 zuse 发消息…'}
          value={value}
          onPaste={onPaste}
          onDrop={onDrop}
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

/** 麦克风图标（与 composer 里其它按钮同一套 stroke 线宽）。 */
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  )
}
