import { useState } from 'react'
import type { DirNav } from '@zuse/protocol'
import { navigateDirs } from '../state/manageApi.js'

/** Last path segment for a compact button label (handles both / and \ separators). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Working-directory picker (S3). A button showing the current session's cwd; clicking opens a
 * dir-only browser: jump between drives, go up to the parent, descend into subfolders, then
 * confirm — which starts a NEW session rooted at the chosen folder (current session untouched).
 */
export function DirPicker({ cwd, onChange }: { cwd: string; onChange: (cwd: string) => void }) {
  const [open, setOpen] = useState(false)
  const [nav, setNav] = useState<DirNav | null>(null)
  const [error, setError] = useState<string | null>(null)
  // "loading" = a fetch is in flight = nav cleared and no error yet; no separate flag needed.

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
    setOpen(true)
    void go(cwd || undefined)
  }
  const confirm = () => {
    if (nav) {
      onChange(nav.path)
      setOpen(false)
    }
  }

  return (
    <div className="dirpick">
      <button className="chip dirpick-btn" title={cwd || 'working directory'} onClick={openPicker}>
        📁 {cwd ? basename(cwd) : '(dir)'}
      </button>
      {open ? (
        <>
          <div className="dirpick-backdrop" onClick={() => setOpen(false)} />
          <div className="dirpick-pop" role="dialog" aria-label="Choose working directory">
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
                <li><button className="dirpick-dir dirpick-up" onClick={() => void go(nav.parent!)}>↑ ..</button></li>
              ) : null}
              {!nav && !error ? <li className="mem-empty">Loading…</li> : null}
              {nav?.dirs.map((d) => (
                <li key={d.path}><button className="dirpick-dir" onClick={() => void go(d.path)}>{d.name}</button></li>
              ))}
              {nav && nav.dirs.length === 0 ? <li className="mem-empty">(no subfolders)</li> : null}
            </ul>
            <div className="dirpick-actions">
              <button className="dirpick-ok" onClick={confirm} disabled={!nav}>Use this folder · new chat</button>
              <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
