import { useEffect, useState } from 'react'

export interface ScriptItem { name: string; command: string }

/**
 * 「▶ 运行 ▾」的下拉内容：当前目录 `package.json` 里的脚本。
 *
 * ## 入口为什么在 Header 而不是右栏
 *
 * 右栏是**输出面，不是入口面**。两条硬理由（都在代码里，不是偏好）：
 *
 * 1. `Shell.tsx` 的 `hasRail` 是「有预览 or 有 exec or 有待办 or 有子代理 or 有步骤」——
 *    新会话 / `/clear` 之后**整栏不渲染**。入口恰好在「你还没开始跑」那一刻不存在。
 * 2. 窄容器下 `.main-body.rail-narrow .rail { display: none }`，同样是没在跑时整栏隐藏。
 *
 * 放在目录 chip 旁边还有个额外的好处：脚本列表是 **cwd 作用域**的，而 cwd 是活的
 * （模型 `cd` 会改它）。目录就显示在旁边，「现在跑的是哪个项目」是肉眼可见的。
 */
export function RunMenu({ sessionId, runningCommands, onPick, onClose }: {
  sessionId: string
  /** 当前在跑的命令（用来把按钮从「运行」变成「重启」）。 */
  runningCommands: Set<string>
  onPick: (s: ScriptItem) => void
  onClose: () => void
}) {
  const [scripts, setScripts] = useState<ScriptItem[] | null>(null)
  const [cwd, setCwd] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        // **每次打开都重新取。** cwd 是活的（`applyCapturedCwd` 让模型的 `cd` 持久生效），
        // 缓存下来就会出现「按钮上写着 A 项目的脚本、跑在 B 项目里」。
        const r = await fetch(`/api/scripts?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const b = await r.json() as { cwd: string; scripts: ScriptItem[] }
        setCwd(b.cwd); setScripts(b.scripts)
      } catch (e) {
        if (!ac.signal.aborted) setErr(String(e))
      }
    })()
    return () => ac.abort()
  }, [sessionId])

  return (
    <div className="run-menu" role="menu" aria-label="运行项目脚本">
      <div className="run-menu-head">{cwd || '读取中…'}</div>
      {err ? <div className="run-menu-empty">读不到脚本：{err}</div> : null}
      {scripts && scripts.length === 0 ? (
        // 没有 package.json 不是错误 —— 大把项目不是 Node 的。说清楚，别显示一个空框。
        <div className="run-menu-empty">这个目录没有 package.json，或者它没有 scripts。</div>
      ) : null}
      {scripts?.map((s) => {
        const isRunning = runningCommands.has(s.command)
        return (
          <button
            key={s.name}
            type="button"
            className="run-menu-item"
            role="menuitem"
            onClick={() => { onPick(s); onClose() }}
          >
            <span className="rm-name">{s.name}</span>
            {/* 已经在跑的时候写「重启」而不是「运行」：点两次会起两个，
                第二个通常因为端口被占秒退，而用户完全不知道发生了什么。 */}
            {isRunning ? <span className="rm-badge">重启</span> : null}
            <span className="rm-cmd">{s.command}</span>
          </button>
        )
      })}
    </div>
  )
}
