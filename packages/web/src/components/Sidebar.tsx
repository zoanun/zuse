export function Sidebar({ onNewChat }: { onNewChat: () => void }) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
      <div className="side-note">One in-memory dev session. History isn’t persisted here yet — “New chat” just clears the view.</div>
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
