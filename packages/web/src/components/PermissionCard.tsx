import type { PendingPermissionLite, PermissionVerdict } from '@zuse/protocol'
import { permissionInputPreview } from './permissionPreview.js'

export function PermissionCard({ pending, onReply }: { pending: PendingPermissionLite; onReply: (id: string, verdict: PermissionVerdict) => void }) {
  const req = pending.req
  const spec = req.toolName + (req.specifier ? ' · ' + req.specifier : '')
  const preview = permissionInputPreview(req.input, req.specifier)
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
      {/*
        **限定符没说的那部分。** 卡片原来只有 `工具名 · 限定符` ——
        对 Bash 够了（限定符就是整条命令），对 `Memory(save)` 就只剩「Memory · save」，
        而这一档的全部价值是「让人看一眼」。入参一直带着完整内容，只是没人渲染。
      */}
      {preview ? <div className="perm-input">{preview}</div> : null}
      <div className="actions">
        <button onClick={() => onReply(pending.id, 'allow')}>允许</button>
        {/*
          **「必须确认」档不显示这两个按钮。** 服务端对这一档什么都不记
          （既不进 sessionAllow 也不落盘），点了与「允许」完全等价 ——
          显示一个点了不算数的按钮比不显示更坏：用户以为自己免掉了以后的询问。
        */}
        {pending.mustConfirm === true ? null : (
          <>
            <button className="ghost" onClick={() => onReply(pending.id, 'allow_session')} title="本次会话内允许">本次会话</button>
            <button className="ghost" onClick={() => onReply(pending.id, 'allow_persist')} title="允许并保存到设置">始终</button>
          </>
        )}
        <button className="ghost" onClick={() => onReply(pending.id, 'deny')}>拒绝</button>
      </div>
      {pending.mustConfirm === true
        ? <div className="perm-note">这一档每次都会问 —— 它写的是以后每个会话都会读到的东西。</div>
        : null}
    </div>
  )
}
