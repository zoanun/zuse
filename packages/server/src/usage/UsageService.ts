import { emptyUsage } from '@zuse/core'
import type { Usage } from '@zuse/core'
import type { UsageStats, UsageModelStat, UsageSessionStat } from '@zuse/protocol'
import { readSessionUsage } from '../session/sessionStore.js'

/** Sum two usages field-by-field (missing cache fields → 0). Mirrors Conversation.addUsage. */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  }
}

/** Total tokens (new input + output + both cache buckets) — the single number we rank by. */
function totalTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/**
 * Token-usage aggregation (M5). Reads every persisted session's recorded usage from the sessions
 * dir and rolls it up: grand total, per-model, and per-session (each biggest-first). Token-only —
 * no cost (the codebase has no pricing). A session that failed over recorded a single model, so the
 * per-model split is approximate; 'unknown' collects sessions that never recorded one.
 */
export class UsageService {
  constructor(private readonly dir: string) {}

  async stats(): Promise<UsageStats> {
    const rows = await readSessionUsage(this.dir)
    let total = emptyUsage()
    const byModelMap = new Map<string, { sessions: number; usage: Usage }>()
    const sessions: UsageSessionStat[] = []

    for (const r of rows) {
      total = addUsage(total, r.totalUsage)
      const key = r.model || 'unknown'
      const m = byModelMap.get(key) ?? { sessions: 0, usage: emptyUsage() }
      m.sessions += 1
      m.usage = addUsage(m.usage, r.totalUsage)
      byModelMap.set(key, m)
      sessions.push({ id: r.id, title: r.title, model: key, updatedAt: r.updatedAt, usage: r.totalUsage })
    }

    const byModel: UsageModelStat[] = [...byModelMap.entries()]
      .map(([model, v]) => ({ model, sessions: v.sessions, usage: v.usage }))
      .sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage))
    sessions.sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage))

    return { total, sessionCount: rows.length, byModel, sessions }
  }
}
