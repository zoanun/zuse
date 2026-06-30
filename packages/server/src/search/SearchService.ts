import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@zuse/core'
import type { SearchHit, SearchSnippet, SessionSearchResult } from '@zuse/protocol'
import { stripUserStamp } from '../session/userStamp.js'

interface ProseDoc { msgIndex: number; role: 'user' | 'assistant'; text: string }
type SessionLite = SessionSearchResult['session']
interface CacheEntry { mtimeMs: number; meta: SessionLite; docs: ProseDoc[] }

const SNIPPET_RADIUS = 40
const DEFAULT_LIMIT = 100
const DEFAULT_PER_SESSION_CAP = 5

/** path → 抽取出的人话 + 会话元信息,按文件 mtime 失效。与 listSessions 的 metaCache 同模式、各自一份。 */
const proseCache = new Map<string, CacheEntry>()

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
    const limit = opts.limit ?? DEFAULT_LIMIT
    const cap = opts.perSessionCap ?? DEFAULT_PER_SESSION_CAP
    const needle = query.toLowerCase()

    let files: string[]
    try { files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')) }
    catch { return [] }

    const seen = new Set<string>()
    const results: SessionSearchResult[] = []
    for (const f of files) {
      const path = join(this.dir, f)
      seen.add(path)
      let entry: CacheEntry
      try {
        const mtimeMs = (await stat(path)).mtimeMs
        const cached = proseCache.get(path)
        if (cached && cached.mtimeMs === mtimeMs) {
          entry = cached
        } else {
          const rec = JSON.parse(await readFile(path, 'utf8')) as {
            id?: unknown; title?: unknown; cwd?: unknown; updatedAt?: unknown; messages?: unknown
          }
          if (typeof rec.id !== 'string' || !Array.isArray(rec.messages)) continue
          entry = {
            mtimeMs,
            meta: {
              id: rec.id,
              title: typeof rec.title === 'string' ? rec.title : '',
              cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
              updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
            },
            docs: extractProse(rec.messages as Message[]),
          }
          proseCache.set(path, entry)
        }
      } catch { continue }

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
    // 清理已消失文件的缓存项(防无界增长)。
    for (const path of proseCache.keys()) if (!seen.has(path)) proseCache.delete(path)

    results.sort((a, b) => (a.session.updatedAt < b.session.updatedAt ? 1 : -1))
    return results.slice(0, limit)
  }
}
