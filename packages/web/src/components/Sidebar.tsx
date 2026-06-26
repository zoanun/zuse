import type { CheckpointLite } from '@zuse/protocol'
import { CheckpointTimeline } from './CheckpointTimeline.js'

interface Props {
  onNewChat: () => void
  checkpoints: CheckpointLite[]
  thinking: boolean
  onRevert: (checkpointId: string) => void
}

export function Sidebar({ onNewChat, checkpoints, thinking, onRevert }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
      <div className="side-note">One in-memory dev session. History isn't persisted here yet — "New chat" just clears the view.</div>
      <CheckpointTimeline checkpoints={checkpoints} thinking={thinking} onRevert={onRevert} />
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
