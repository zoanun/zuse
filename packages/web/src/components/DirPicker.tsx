import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirNav } from '@zuse/protocol'
import { navigateDirs } from '../state/manageApi.js'

/** Last path segment for a compact button label (handles both / and \ separators). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Explorer-style manila folder glyph shown against each directory row. */
function FolderIcon() {
  return (
    <svg className="dirpick-ico dirpick-ico-folder" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  )
}

/** Up-a-level glyph for the parent-directory row. */
function UpIcon() {
  return (
    <svg className="dirpick-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V6" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

/**
 * Working-directory picker (S3). A button showing the current session's cwd; clicking opens a
 * dir-only browser: jump between drives, go up to the parent, descend into subfolders, then
 * confirm — which starts a NEW session rooted at the chosen folder (current session untouched).
 */
export interface DirPickerHandle { open: () => void }

export const DirPicker = forwardRef<DirPickerHandle, { cwd: string; onChange: (cwd: string) => void }>(
  function DirPicker({ cwd, onChange }, ref) {
  const [open, setOpen] = useState(false)
  const [nav, setNav] = useState<DirNav | null>(null)
  const [error, setError] = useState<string | null>(null)
  // "loading" = a fetch is in flight = nav cleared and no error yet; no separate flag needed.
  // Anchor the (portaled) popover to the button's on-screen position.
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  const go = async (path?: string) => {
    setNav(null)
    setError(null)
    try {
      setNav(await navigateDirs(path))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openPicker = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setOpen(true)
    void go(cwd || undefined)
  }
  useImperativeHandle(ref, () => ({ open: openPicker }), [cwd])
  const confirm = () => {
    if (nav) {
      onChange(nav.path)
      setOpen(false)
    }
  }

  return (
    <div className="dirpick">
      <button ref={btnRef} className="chip dirpick-btn" title={cwd || '工作目录'} onClick={openPicker}>
        📁 {cwd ? basename(cwd) : '(目录)'}
      </button>
      {open ? createPortal(
        <>
          <div className="dirpick-backdrop" onClick={() => setOpen(false)} />
          <div className="dirpick-pop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="选择工作目录">
            <div className="dirpick-cur" title={nav?.path}>{nav?.path ?? '…'}</div>
            {nav && nav.drives.length > 0 ? (
              <div className="dirpick-drives">
                {nav.drives.map((d) => (
                  <button key={d} className="dirpick-drive" onClick={() => void go(d)}>{d}</button>
                ))}
              </div>
            ) : null}
            {error ? <div className="mem-error">{error}</div> : null}
            <ul className="dirpick-list">
              {nav?.parent ? (
                <li><button className="dirpick-dir dirpick-up" onClick={() => void go(nav.parent!)}><UpIcon /><span className="dirpick-name">..</span></button></li>
              ) : null}
              {!nav && !error ? <li className="mem-empty">加载中…</li> : null}
              {nav?.dirs.map((d) => (
                <li key={d.path}><button className="dirpick-dir" onClick={() => void go(d.path)}><FolderIcon /><span className="dirpick-name">{d.name}</span></button></li>
              ))}
              {nav && nav.dirs.length === 0 ? <li className="mem-empty">(无子目录)</li> : null}
            </ul>
            <div className="dirpick-actions">
              <button className="dirpick-ok" onClick={confirm} disabled={!nav}>使用此目录</button>
            </div>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  )
})
