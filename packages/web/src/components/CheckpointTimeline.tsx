import { useState } from 'react'
import type { CheckpointLite } from '@zuse/protocol'

interface Props {
  checkpoints: CheckpointLite[]
  thinking: boolean
  onRevert: (checkpointId: string) => void
}

export function CheckpointTimeline({ checkpoints, thinking, onRevert }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  if (checkpoints.length === 0) {
    return (
      <div className="ckpt-list">
        <div className="ckpt-empty">No checkpoints yet</div>
      </div>
    )
  }

  return (
    <div className="ckpt-list">
      <div className="side-label">Checkpoints</div>
      {checkpoints.map((cp) => (
        <div key={cp.id} className="ckpt-row">
          <span className="ckpt-label">{cp.label}</span>
          {confirmId === cp.id ? (
            <span className="ckpt-confirm">
              <button
                className="ghost ckpt-btn"
                onClick={() => { onRevert(cp.id); setConfirmId(null) }}
              >
                Confirm
              </button>
              <button
                className="ghost ckpt-btn"
                onClick={() => setConfirmId(null)}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              className="ghost ckpt-btn"
              disabled={thinking}
              onClick={() => setConfirmId(cp.id)}
            >
              Revert
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
