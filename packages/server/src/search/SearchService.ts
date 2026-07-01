import type { Message } from '@zuse/core'
import type { SearchHit, SearchSnippet, SessionSearchResult } from '@zuse/protocol'
import { stripUserStamp } from '../session/userStamp.js'
import { scanSessionDir, type ScanEntry } from '../session/sessionStore.js'

interface ProseDoc { msgIndex: number; role: 'user' | 'assistant'; text: string }
type SessionLite = SessionSearchResult['session']
/** One session's searchable payload: its list metadata + the extracted prose docs. */
interface ProseEntry { meta: SessionLite; docs: ProseDoc[] }

const SNIPPET_RADIUS = 80
const DEFAULT_LIMIT = 100
const DEFAULT_PER_SESSION_CAP = 5

/** path → 抽取出的人话 + 会话元信息;扫描/stat/缓存失效由 scanSessionDir 统一管理。 */
const proseCache = new Map<string, ScanEntry<ProseEntry>>()

/** 仅取 user/assistant 的 text 块;user 文本剥时间戳前缀;丢空文本与工具块。 */
function extractProse(messages: Message[]): ProseDoc[] {
  const docs: ProseDoc[] = []
  messages.forEach((m, i) => {
    if (m.role !== 'user' && m.role !== 'assistant') return
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    const clean = m.role === 'user' ? stripUserStamp(text) : text
    if (clean.trim() !== '') docs.push({ msgIndex: i, role: m.role, text: clean })
  })
  return docs
}

/** Build one session's searchable payload from a parsed record, or null to skip a bad record. */
function buildProseEntry(rec: unknown): ProseEntry | null {
  const r = rec as { id?: unknown; title?: unknown; cwd?: unknown; updatedAt?: unknown; messages?: unknown }
  if (typeof r.id !== 'string' || !Array.isArray(r.messages)) return null
  return {
    meta: {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    },
    docs: extractProse(r.messages as Message[]),
  }
}

function makeSnippet(text: string, at: number, qlen: number): SearchSnippet {
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + qlen + SNIPPET_RADIUS)
  return {
    pre: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + qlen),
    post: text.slice(at + qlen, end) + (end < text.length ? '…' : ''),
  }
}

export class SearchService {
  private readonly dir: string
  constructor(opts: { dir: string }) { this.dir = opts.dir }

  async search(q: string, opts: { limit?: number; perSessionCap?: number } = {}): Promise<SessionSearchResult[]> {
    const query = q.trim()
    if (query === '') return []
    // Treat a non-positive limit/cap as "unset" — `?? DEFAULT` alone would keep 0 (not nullish),
    // which slices everything away and yields a spurious "no matches".
    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT
    const cap = opts.perSessionCap && opts.perSessionCap > 0 ? opts.perSessionCap : DEFAULT_PER_SESSION_CAP
    const needle = query.toLowerCase()

    const entries = await scanSessionDir<ProseEntry>(this.dir, proseCache, buildProseEntry)
    const results: SessionSearchResult[] = []
    for (const entry of entries) {
      const hits: SearchHit[] = []
      let hitCount = 0
      for (const d of entry.docs) {
        const at = d.text.toLowerCase().indexOf(needle)
        if (at < 0) continue
        hitCount++
        if (hits.length < cap) hits.push({ msgIndex: d.msgIndex, role: d.role, snippet: makeSnippet(d.text, at, query.length) })
      }
      if (hitCount > 0) results.push({ session: entry.meta, hits, hitCount })
    }
    // 3-way comparator (returns 0 on equal updatedAt) so tied sessions keep a stable order.
    results.sort((a, b) => {
      const x = a.session.updatedAt, y = b.session.updatedAt
      return x < y ? 1 : x > y ? -1 : 0
    })
    return results.slice(0, limit)
  }
}
