import type { PendingPermissionLite, PermissionVerdict } from '@zuse/protocol'

export function PermissionCard({ pending, onReply }: { pending: PendingPermissionLite; onReply: (id: string, verdict: PermissionVerdict) => void }) {
  const req = pending.req
  const spec = req.toolName + (req.specifier ? ' · ' + req.specifier : '')
  return (
    <div className="perm">
      <div className="q">允许此操作？</div>
      <div className="spec">{spec}</div>
      <div className="actions">
        <button onClick={() => onReply(pending.id, 'allow')}>允许</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'allow_session')} title="本次会话内允许">本次会话</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'allow_persist')} title="允许并保存到设置">始终</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'deny')}>拒绝</button>
      </div>
    </div>
  )
}
