import type { PermissionMode } from '@zuse/protocol'

/**
 * 全自主档的**常驻**横幅（不是小 chip）。
 *
 * 为什么是常驻横幅而不是一次性 toast：这一档改的是安全姿态，而人会忘。
 * toast 消失之后，界面上就再没有任何东西提醒「你现在开着全自主」——
 * 下一次它默默跑掉一条你本会拦下的命令时，才是最坏的发现时机。
 *
 * 计数只算「换成询问档就会被拦下来问你」的那些调用（服务端做的反事实判定），
 * 不是「全自主档下跑过的所有工具」—— 后者会被一堆本来就免问的只读调用灌满，
 * 那个数字读起来像活跃度指标，而不是「你少点了多少次确认」。
 *
 * 文案刻意不宣称任何护栏厚度：这一档之上只剩 deny 表与 Bash 安全检查，
 * 而 deny 表是字面前缀匹配（`Bash(rm -rf *)` 拦不住 `rm -fr /`）。
 */
export function BypassBanner({ mode, count, onExit }: { mode: PermissionMode; count: number; onExit: () => void }) {
  if (mode !== 'bypass') return null
  return (
    <div className="bypass-banner" role="status">
      <span className="bypass-banner-text">
        <strong>全自主</strong>：本会话已自动放行 {count} 次本会向你确认的调用。
        仅 deny 规则与 Bash 安全检查仍然生效。
      </span>
      <button type="button" className="bypass-banner-exit" onClick={onExit}>切回询问</button>
    </div>
  )
}
