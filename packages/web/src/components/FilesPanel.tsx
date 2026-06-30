import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing, FileEntry, FilePreview } from '@zuse/protocol'

// Terminal-captured files (e.g. .zuse/tool-output/*) embed ANSI escape codes; strip them so the
// preview reads as plain text instead of `␛[1m␛[36m…` noise. Matches CSI sequences (SGR colors,
// cursor moves). The server still returns raw bytes — this is a display-only clean-up.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

interface Props {
  active: boolean
  loadDir: (dir: string) => Promise<DirListing>
  loadFile: (path: string) => Promise<FilePreview>
}

/**
 * Read-only project file browser (M7). Lazy tree: a directory's children are fetched the first
 * time it's expanded; clicking a file fetches a size-capped preview into the pane below. All
 * fetching is injected (loadDir/loadFile) so the panel is testable without the network.
 */
export function FilesPanel({ active, loadDir, loadFile }: Props) {
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [root, setRoot] = useState<string>('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

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
    setPreviewLoading(true)
    setError(null)
    try {
      setPreview(await loadFile(path))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewLoading(false)
    }
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
          <div className="file-preview-head" title={selected}>{selected}</div>
          {previewLoading ? (
            <div className="mem-empty">加载中…</div>
          ) : preview ? (
            preview.binary ? (
              <div className="mem-empty">二进制文件（{preview.size} 字节）— 无法预览。</div>
            ) : (
              <pre className="file-preview-body">{stripAnsi(preview.content)}{preview.truncated ? '\n\n[… 已截断]' : ''}</pre>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
