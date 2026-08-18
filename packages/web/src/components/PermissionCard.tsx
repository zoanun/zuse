import type { PendingPermissionLite, PermissionVerdict } from '@zuse/protocol'

export function PermissionCard({ pending, onReply }: { pending: PendingPermissionLite; onReply: (id: string, verdict: PermissionVerdict) => void }) {
  const req = pending.req
  const spec = req.toolName + (req.specifier ? ' · ' + req.specifier : '')
  return (
    <div className="perm">
      <div className="q">允许此操作？</div>
      {/*
        **`reason` 的注释一直写着「供权限对话框展示，让用户知道为何被拦」，而这里从来没渲染过它。**
        对 Bash 尤其要命：命令可能上百行（heredoc），只显示整条命令的话，用户看不出是哪个字
        触发的 —— 而这一档的全部价值就是「让人看一眼」。放在命令**上面**：先说为什么，再看是什么。
      */}
      {req.reason ? <div className="perm-reason">{req.reason}</div> : null}
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
