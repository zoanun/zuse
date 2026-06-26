import type { PendingPermissionLite, PermissionVerdict } from '@zuse/protocol'

export function PermissionCard({ pending, onReply }: { pending: PendingPermissionLite; onReply: (id: string, verdict: PermissionVerdict) => void }) {
  const req = pending.req
  const spec = req.toolName + (req.specifier ? ' · ' + req.specifier : '')
  return (
    <div className="perm">
      <div className="q">Allow this action?</div>
      <div className="spec">{spec}</div>
      <div className="actions">
        <button onClick={() => onReply(pending.id, 'allow')}>Allow</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'allow_session')} title="Allow for this session">Session</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'allow_persist')} title="Allow and save to settings">Always</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'deny')}>Deny</button>
      </div>
    </div>
  )
}
