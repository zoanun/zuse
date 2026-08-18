/**
 * 受信目录的管理面板 —— 列出来、撤销掉。
 *
 * ## 为什么必须有这个面板
 *
 * 「信任一个目录」= 允许它的 `.zuse/settings.json` **放宽**本会话的配置
 * （allow / defaultMode / providers / model）。这是能关掉全部护栏的那一半。
 * 而在这个面板之前，产品里**只有信任按钮，没有撤销入口** —— 唯一的办法是手改
 * `~/.zuse/trusted-roots.json`。一个只能加不能减的信任表是个陷阱。
 *
 * 「目录已经不在」必须标出来：信任比的是**路径字面量**（刻意不做 realpath，
 * 理由是 TOCTOU），所以同一个路径日后被重建 —— 比如把另一个仓库 clone 回原来的
 * 位置 —— 会直接继承那份信任。用户看不见陈旧条目就不会去清它。
 */
export function TrustedRootsPanel({ roots, missing, loading, error, onUntrust }: {
  roots: string[]
  missing: string[]
  loading?: boolean
  error?: string | null
  onUntrust: (root: string) => void
}) {
  const gone = new Set(missing)
  return (
    <div className="trust-panel">
      <p className="mem-hint">
        这些目录的 <code>.zuse/settings.json</code> 可以**放宽**本会话的配置
        （allow / 默认权限档 / 模型 / provider）。收紧的 deny/ask 不需要信任，一律生效。
      </p>
      {error != null ? <div className="mem-error">{error}</div> : null}
      {loading === true ? <div className="mem-empty">加载中…</div> : null}
      {error == null && loading !== true && roots.length === 0 ? (
        <div className="mem-empty">还没有信任过任何目录。</div>
      ) : null}
      <ul className="trust-list">
        {roots.map((r) => (
          <li key={r} className={'trust-row' + (gone.has(r) ? ' missing' : '')}>
            <span className="trust-path">{r}</span>
            {gone.has(r) ? (
              <span className="trust-stale" title="这个目录现在不存在。若同一路径日后被重建，它会直接继承这份信任 —— 建议撤销。">
                目录已不存在
              </span>
            ) : null}
            <button className="ghost" onClick={() => onUntrust(r)}>撤销信任</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
