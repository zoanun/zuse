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
      <span title="New input tokens (excludes cache)">in {formatTokens(usage.input_tokens)}</span>
      <span title="Output tokens">out {formatTokens(usage.output_tokens)}</span>
      {cacheRead > 0 ? <span title="Input tokens served from the prompt cache (cheap cache hits)">cache read {formatTokens(cacheRead)}</span> : null}
      {cacheWrite > 0 ? <span title="Input tokens newly written to the prompt cache (first turn: system prompt + tool defs; later turns: new conversation)">cache write {formatTokens(cacheWrite)}</span> : null}
    </span>
  )
}

export function UsagePanel({ stats, loading, error }: Props) {
  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">Token usage across all saved sessions (no cost — token-only). Per-model totals are approximate when a session failed over between models.</div>
      </div>

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">Loading…</div> : null}

      {stats && !loading ? (
        stats.sessionCount === 0 ? (
          <div className="mem-empty">No usage recorded yet.</div>
        ) : (
          <>
            <div className="usage-total">
              <div className="usage-total-num">{formatTokens(totalTokens(stats.total))}</div>
              <div className="usage-total-label">total tokens · {stats.sessionCount} session{stats.sessionCount === 1 ? '' : 's'}</div>
              <Breakdown usage={stats.total} />
            </div>

            <div className="usage-section-title">By model</div>
            <ul className="mem-list">
              {stats.byModel.map((m) => (
                <li key={m.model} className="usage-row">
                  <span className="usage-name" title={m.model}>{m.model}</span>
                  <span className="usage-sub">{m.sessions} session{m.sessions === 1 ? '' : 's'}</span>
                  <span className="usage-tokens">{formatTokens(totalTokens(m.usage))}</span>
                </li>
              ))}
            </ul>

            <div className="usage-section-title">By session</div>
            <ul className="mem-list">
              {stats.sessions.map((s) => (
                <li key={s.id} className="usage-row">
                  <span className="usage-name" title={s.title || s.id}>{s.title || '(untitled)'}</span>
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
