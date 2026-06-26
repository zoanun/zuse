interface Props {
  onNewChat: () => void
}

export function Sidebar({ onNewChat }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
      <div className="side-note">"New chat" starts a fresh session. The session list lands soon.</div>
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
