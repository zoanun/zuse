import { useState } from 'react'

/**
 * 「这个目录的配置只生效了一半」的提示条。
 *
 * ## 为什么需要它
 *
 * 会话可以 root 到任意目录，而那个目录的 `.zuse/settings.json` **不在 .gitignore 里**
 * —— 它随仓库分发。所以配置按**方向**分成两半：
 *
 * - **收紧**（`deny` / `ask`）：无条件生效。它们只能让判定更严。
 * - **放宽**（`allow` / `defaultMode` / `providers` / `model`）：**必须**你点头。
 *   否则「clone 一个仓库 → 在里面开会话」就能关掉你全部护栏、
 *   把整段对话导向别人的 endpoint。
 *
 * 没有这个提示的话，用户会看到「我配的 allow 怎么不生效」而无从查起 ——
 * 默认不信任是安全的，但**沉默**不是。
 *
 * ## 只在「值得说」的时候出现
 *
 * daemon 自己的项目根不提（那是它本来就读的那份）；已经信任过的不提。
 */
export function TrustNotice({ root, trusted, onTrusted }: {
  root: string | undefined
  trusted: boolean | undefined
  onTrusted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // `trusted === undefined` = 老 daemon 没给这两个字段 —— 什么都不显示，别吓人。
  if (!root || trusted !== false) return null

  const trust = async (): Promise<void> => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/trusted-roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      onTrusted()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="trust-notice" role="status">
      <span className="trust-notice-text">
        这个目录（<code>{root}</code>）的配置只生效了一半：它的 deny/ask 已经在管事，
        但 allow / 模型 / provider 这些**放宽**的设置需要你确认后才读 ——
        因为 <code>.zuse/settings.json</code> 是会随仓库分发的。
      </span>
      <button className="trust-notice-btn" onClick={() => void trust()} disabled={busy}>
        {busy ? '正在保存…' : '信任这个目录'}
      </button>
      {err !== null && <span className="trust-notice-err">没能保存：{err}</span>}
    </div>
  )
}
