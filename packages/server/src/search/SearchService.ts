import type { Message } from '@zuse/core'
import type { SearchHit, SearchSnippet, SessionSearchResult } from '@zuse/protocol'
import { stripUserStamp } from '../session/userStamp.js'
import { scanSessionDir, byUpdatedAtDesc, type ScanEntry, type SessionRecord } from '../session/sessionStore.js'

interface ProseDoc { msgIndex: number; id: string; role: 'user' | 'assistant'; text: string }
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
    // Guard m.content: a message missing it (older schema / partial write / hand-edit) would throw,
    // and scanSessionDir's per-file catch would then drop the WHOLE session from search results.
    const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    const clean = m.role === 'user' ? stripUserStamp(text) : text
    if (clean.trim() !== '') docs.push({ msgIndex: i, id: m.id, role: m.role, text: clean })
  })
  return docs
}

/** Build one session's searchable payload from a parsed record, or null to skip a bad record. */
function buildProseEntry(rec: unknown): ProseEntry | null {
  const r = rec as Partial<SessionRecord>
  if (typeof r.id !== 'string' || !Array.isArray(r.messages)) return null
  // 与 listSessions 同口径:cron 会话有自己的回看入口(定时任务面板),不进普通检索。
  if (r.kind === 'cron') return null
  return {
    meta: {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    },
    docs: extractProse(r.messages),
  }
}

/** Escape regex metacharacters so a raw query matches literally inside `new RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    // Case-insensitive match ON THE ORIGINAL text: m.index is an original-text offset (unlike
    // text.toLowerCase().indexOf, whose offset desyncs when folding changes length, e.g. İ→i̇),
    // and m[0] is the actually-matched substring so the highlight length is correct too.
    const re = new RegExp(escapeRegExp(query), 'i')

    const entries = await scanSessionDir<ProseEntry>(this.dir, proseCache, buildProseEntry)
    const results: SessionSearchResult[] = []
    for (const entry of entries) {
      const all: SearchHit[] = []
      for (const d of entry.docs) {
        const m = re.exec(d.text)
        if (m === null) continue
        all.push({ msgIndex: d.msgIndex, id: d.id, role: d.role, snippet: makeSnippet(d.text, m.index, m[0].length) })
      }
      if (all.length === 0) continue
      // Keep the LAST `cap` hits (most recent by message order), dropping older ones; hitCount
      // records the true total so the UI's "还有 N 条" reflects how many earlier hits were dropped.
      const hits = all.length > cap ? all.slice(all.length - cap) : all
      results.push({ session: entry.meta, hits, hitCount: all.length })
    }
    results.sort((a, b) => byUpdatedAtDesc(a.session.updatedAt, b.session.updatedAt))
    return results.slice(0, limit)
  }
}
