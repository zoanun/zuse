import { useRef, useState } from 'react'
import type { SessionMeta } from '@zuse/protocol'

interface Props {
  sessions: SessionMeta[]
  currentSessionId: string
  onNewChat: () => void
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
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

export function Sidebar({ sessions, currentSessionId, onNewChat, onSwitch, onDelete, onRename }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
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
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
