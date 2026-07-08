import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing, FileEntry, FilePreview } from '@zuse/protocol'
import { classify } from './fileView.js'
import { CodeEditor } from './CodeEditor.js'
import { FileConflictError } from '../state/manageApi.js'

interface Props {
  active: boolean
  loadDir: (dir: string) => Promise<DirListing>
  loadFile: (path: string) => Promise<FilePreview>
  writeFile: (path: string, content: string, opts?: { expectMtimeMs?: number; force?: boolean }) => Promise<{ path: string; size: number; mtimeMs: number }>
  deleteFile: (path: string) => Promise<void>
  rawUrl: (path: string) => string
}

/**
 * Project file browser (M7, I3). Lazy tree: a directory's children are fetched the first time
 * it's expanded. Clicking a file routes by extension — text fetches a size-capped preview,
 * image/pdf render straight from the raw-bytes endpoint, everything else gets a download link.
 * All fetching is injected (loadDir/loadFile/…) so the panel is testable without the network.
 */
export function FilesPanel({ active, loadDir, loadFile, writeFile, deleteFile, rawUrl }: Props) {
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [root, setRoot] = useState<string>('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [view, setView] = useState<'text' | 'image' | 'pdf' | 'other'>('text')
  const [buffer, setBuffer] = useState('')        // editor content
  const [baseMtime, setBaseMtime] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false) // a 409 awaiting overwrite confirm
  const dirty = preview != null && !preview.binary && !preview.truncated && buffer !== preview.content

  const fetchDir = useCallback(async (dir: string) => {
    try {
      const listing = await loadDir(dir)
      setChildren((m) => new Map(m).set(dir, listing.entries))
      if (dir === '') setRoot(listing.root)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [loadDir])

  // Load the root once, the first time the panel becomes active. Gated on a ref (not the whole
  // `children` Map) so the effect fires only on activation — not after every directory fetch.
  const rootRequested = useRef(false)
  useEffect(() => {
    if (active && !rootRequested.current) {
      rootRequested.current = true
      void fetchDir('')
    }
  }, [active, fetchDir])

  const toggleDir = (path: string) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })
    if (!children.has(path)) void fetchDir(path)
  }

  const openFile = async (path: string) => {
    setSelected(path)
    setPreview(null)
    setError(null)
    const v = classify(path)
    setView(v)
    if (v !== 'text') { setPreviewLoading(false); return } // image/pdf/other render from rawUrl, no content fetch
    setPreviewLoading(true)
    try {
      const p = await loadFile(path)
      setPreview(p); setBuffer(p.content); setBaseMtime(p.mtimeMs); setConflict(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  const doSave = async (force = false) => {
    if (!selected) return
    setSaving(true); setError(null)
    try {
      const r = await writeFile(selected, buffer, force ? { force: true } : { expectMtimeMs: baseMtime ?? undefined })
      setBaseMtime(r.mtimeMs); setConflict(false)
      setPreview((prev) => (prev ? { ...prev, content: buffer, mtimeMs: r.mtimeMs } : prev)) // clear dirty
    } catch (e) {
      if (e instanceof FileConflictError) setConflict(true)
      else setError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  // Flatten the visible tree to indented rows (depth-first, only expanded dirs descend).
  const renderLevel = (dir: string, depth: number): React.ReactNode[] => {
    const entries = children.get(dir) ?? []
    return entries.flatMap((e) => {
      const isDir = e.type === 'dir'
      const isOpen = expanded.has(e.path)
      const row = (
        <li key={e.path} className="file-node">
          <button
            className={'file-row' + (selected === e.path ? ' sel' : '')}
            style={{ paddingLeft: depth * 14 + 8 + 'px' }}
            onClick={() => (isDir ? toggleDir(e.path) : openFile(e.path))}
          >
            <span className="file-twirl">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
            <span className="file-name">{e.name}</span>
          </button>
        </li>
      )
      return isDir && isOpen ? [row, ...renderLevel(e.path, depth + 1)] : [row]
    })
  }

  return (
    <div className="mem-panel">
      {root ? <div className="file-root" title={root}>{root}</div> : null}
      {error ? <div className="mem-error">{error}</div> : null}
      <ul className="file-tree">
        {children.has('') ? renderLevel('', 0) : <li className="mem-empty">加载中…</li>}
      </ul>

      {selected ? (
        <div className="file-preview">
          {/* No title tooltip here: it would collide with the iframe's title in findByTitle and a11y. */}
          <div className="file-preview-head">{selected}</div>
          {view === 'image' ? (
            <img className="file-img" src={rawUrl(selected)} alt={selected} />
          ) : view === 'pdf' ? (
            <iframe className="file-frame" src={rawUrl(selected)} title={selected} />
          ) : view === 'other' ? (
            <div className="file-cannot">无法展示此类型文件。<a href={rawUrl(selected)} download>下载</a></div>
          ) : previewLoading ? (
            <div className="mem-empty">加载中…</div>
          ) : preview ? (
            preview.binary || preview.truncated ? (
              <div className="file-cannot">{preview.binary ? '二进制文件，无法展示。' : '文件过大，无法编辑。'} <a href={rawUrl(selected)} download>下载</a></div>
            ) : (
              <div className="file-editor">
                <div className="file-editbar">
                  <button className={'file-save' + (dirty ? ' dirty' : '')} disabled={!dirty || saving} onClick={() => void doSave()}>保存</button>
                  {conflict ? (
                    <span className="file-conflict">文件已在磁盘变更。<button onClick={() => void doSave(true)}>覆盖</button></span>
                  ) : null}
                  {error ? <span className="file-cannot">{error}</span> : null}
                </div>
                <CodeEditor path={selected} value={buffer} onChange={setBuffer} onSave={() => void doSave()} />
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
