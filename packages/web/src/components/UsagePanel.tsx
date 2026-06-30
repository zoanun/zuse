import type { Usage, UsageStats } from '@zuse/protocol'

interface Props {
  stats?: UsageStats
  loading?: boolean
  error?: string | null
}

/** 1234 → "1.2k", 1_000_000 → "1M". Compact token counts (mirrors the TUI footer's helper). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`
  }
  return String(n)
}

/** Sum of every bucket — the headline token number. input_tokens excludes cache, so add it back. */
export function totalTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

function Breakdown({ usage }: { usage: Usage }) {
  // Show every bucket the headline counts, so in+out+cache adds back up to the total. The first
  // turn of a session writes the whole system prompt + tool defs to the cache → a big cache-write.
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return (
    <span className="usage-break">
      <span title="新输入 token（不含缓存）">in {formatTokens(usage.input_tokens)}</span>
      <span title="输出 token">out {formatTokens(usage.output_tokens)}</span>
      {cacheRead > 0 ? <span title="从 prompt 缓存命中读取的输入 token（廉价的缓存命中）">cache read {formatTokens(cacheRead)}</span> : null}
      {cacheWrite > 0 ? <span title="新写入 prompt 缓存的输入 token（首回合：系统提示 + 工具定义；后续回合：新增对话）">cache write {formatTokens(cacheWrite)}</span> : null}
    </span>
  )
}

export function UsagePanel({ stats, loading, error }: Props) {
  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">所有已保存会话的 token 用量（不计费用，仅统计 token）。会话在不同模型间发生故障切换时，各模型的统计为近似值。</div>
      </div>

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">加载中…</div> : null}

      {stats && !loading ? (
        stats.sessionCount === 0 ? (
          <div className="mem-empty">暂无用量记录。</div>
        ) : (
          <>
            <div className="usage-total">
              <div className="usage-total-num">{formatTokens(totalTokens(stats.total))}</div>
              <div className="usage-total-label">总 token · {stats.sessionCount} 个会话</div>
              <Breakdown usage={stats.total} />
            </div>

            <div className="usage-section-title">按模型</div>
            <ul className="mem-list">
              {stats.byModel.map((m) => (
                <li key={m.model} className="usage-row">
                  <span className="usage-name" title={m.model}>{m.model}</span>
                  <span className="usage-sub">{m.sessions} 个会话</span>
                  <span className="usage-tokens">{formatTokens(totalTokens(m.usage))}</span>
                </li>
              ))}
            </ul>

            <div className="usage-section-title">按会话</div>
            <ul className="mem-list">
              {stats.sessions.map((s) => (
                <li key={s.id} className="usage-row">
                  <span className="usage-name" title={s.title || s.id}>{s.title || '(未命名)'}</span>
                  <span className="usage-sub" title={s.model}>{s.model}</span>
                  <span className="usage-tokens">{formatTokens(totalTokens(s.usage))}</span>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </div>
  )
}
