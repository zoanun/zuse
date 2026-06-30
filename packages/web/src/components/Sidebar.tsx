import { useEffect, useRef, useState } from 'react'
import type { SessionMeta, SessionSearchResult } from '@zuse/protocol'
import { searchSessions } from '../state/session.js'

interface Props {
  sessions: SessionMeta[]
  currentSessionId: string
  onNewChat: () => void
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onJump: (sessionId: string, msgIndex: number) => void
}

function titleOf(s: SessionMeta): string {
  return s.title.trim() === '' ? 'New chat' : s.title
}

function SessionRow({ s, active, onSwitch, onDelete, onRename }: {
  s: SessionMeta
  active: boolean
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  // Set when Esc cancels, so the blur fired by unmounting the input doesn't commit.
  const cancelled = useRef(false)

  const startEdit = () => { setDraft(titleOf(s)); cancelled.current = false; setEditing(true) }
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setEditing(false); return }
    const t = draft.trim()
    // Only a real change is a rename. A no-op edit (double-click then blur without
    // changing anything) must NOT pin the title as manual — that would freeze it and
    // override the auto-generated title.
    if (t !== '' && t !== titleOf(s)) onRename(s.id, t)
    setEditing(false)
  }
  const cancel = () => { cancelled.current = true; setEditing(false) }

  if (editing) {
    return (
      <li className={'session-item' + (active ? ' active' : '')}>
        <input
          className="session-rename-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
        />
      </li>
    )
  }

  return (
    <li
      className={'session-item' + (active ? ' active' : '')}
      onClick={() => onSwitch(s.id)}
    >
      <span className="session-title" onDoubleClick={(e) => { e.stopPropagation(); startEdit() }}>
        {titleOf(s)}
      </span>
      {confirming ? (
        <span className="session-confirm" onClick={(e) => e.stopPropagation()}>
          <button
            className="session-confirm-yes"
            title="Confirm delete"
            aria-label="Confirm delete"
            onClick={(e) => { e.stopPropagation(); setConfirming(false); onDelete(s.id) }}
          >✓</button>
          <button
            className="session-confirm-no"
            title="Cancel"
            aria-label="Cancel delete"
            onClick={(e) => { e.stopPropagation(); setConfirming(false) }}
          >✕</button>
        </span>
      ) : (
        <button
          className="session-del"
          title="Delete session"
          aria-label="Delete session"
          onClick={(e) => { e.stopPropagation(); setConfirming(true) }}
        >×</button>
      )}
    </li>
  )
}

export function Sidebar({ sessions, currentSessionId, onNewChat, onSwitch, onDelete, onRename, onJump }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[] | null>(null)
  const [searchErr, setSearchErr] = useState(false)
  const reqSeq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q === '') { setResults(null); setSearchErr(false); return }
    const seq = ++reqSeq.current
    const ac = new AbortController()
    const t = setTimeout(() => {
      void searchSessions(q, ac.signal)
        .then((r) => { if (seq === reqSeq.current) { setResults(r); setSearchErr(false) } })
        .catch(() => { if (seq === reqSeq.current) { setSearchErr(true); setResults([]) } })
    }, 200)
    return () => { clearTimeout(t); ac.abort() }
  }, [query])

  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
      <div className="search-box">
        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          className="session-search"
          placeholder="搜索历史…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {results !== null ? (
        <div className="search-results">
          {searchErr ? <div className="search-empty">搜索失败</div>
            : results.length === 0 ? <div className="search-empty">无匹配</div>
            : results.map((r) => (
              <div key={r.session.id} className="search-group">
                <div className="search-group-head">{r.session.title || 'New chat'}</div>
                {r.hits.map((h) => (
                  <button
                    key={r.session.id + ':' + h.msgIndex}
                    className="search-hit"
                    onClick={() => onJump(r.session.id, h.msgIndex)}
                  >
                    <span className="hit-role">{h.role === 'user' ? '你' : 'zuse'}</span>
                    <span className="hit-snippet">
                      {h.snippet.pre}<mark>{h.snippet.match}</mark>{h.snippet.post}
                    </span>
                  </button>
                ))}
                {r.hitCount > r.hits.length ? <div className="search-more">还有 {r.hitCount - r.hits.length} 条</div> : null}
              </div>
            ))}
        </div>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              active={s.id === currentSessionId}
              onSwitch={onSwitch}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))}
        </ul>
      )}
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
