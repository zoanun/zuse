# S4 历史搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跨会话全文检索——侧边栏搜索框输入关键词，结果按会话分组、定位到具体消息，点击跳转并滚动高亮。

**Architecture:** 后端 `SearchService` 按需扫描已持久化的会话 JSON、对 user/assistant 人话做大小写无关子串匹配（mtime 缓存抽取结果），经 `GET /api/search` 返回分组结果；前端在侧边栏加搜索态，点击命中复用 `switchSession` 并经 `pendingScrollTo` 让 `MessageList` 滚到目标消息。无新增持久化/索引。

**Tech Stack:** TypeScript ESM（import 带 `.js` 后缀）、Node ≥22、pnpm workspace、vitest、React。测试命令 `pnpm vitest run <path>`；类型检查 `pnpm -r typecheck`。

**设计文档:** `docs/superpowers/specs/2026-06-30-s4-history-search-design.md`

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `packages/server/src/session/userStamp.ts`（新） | 共享 `USER_STAMP_RE` + `stripUserStamp`（从 SessionManager 抽出） |
| `packages/protocol/src/index.ts`（改） | 新增 `SearchSnippet`/`SearchHit`/`SessionSearchResult` |
| `packages/server/src/search/SearchService.ts`（新） | 扫描 + 人话 mtime 缓存 + 匹配 + 片段 + 分组排序 |
| `packages/server/src/search/SearchService.test.ts`（新） | SearchService 单测 |
| `packages/server/src/http/server.ts`（改） | `RequestHandlerDeps.search` + `GET /api/search` |
| `packages/server/src/http/server.test.ts`（改） | 路由测试 + fake deps 补 `search` |
| `packages/server/src/http/static.test.ts`（改） | fake deps 补 `search` |
| `packages/server/src/startServer.ts`（改） | 构造 `SearchService` 并注入 deps |
| `packages/web/src/state/session.ts`（改） | `searchSessions(q, signal)` 客户端 |
| `packages/web/src/state/store.tsx`（改） | `pendingScrollTo` 状态 + `searchJump` |
| `packages/web/src/components/Sidebar.tsx`（改） | 搜索框 + 结果模式 + 点击跳转 |
| `packages/web/src/components/Sidebar.test.tsx`（改） | 前端测试 |
| `packages/web/src/components/MessageList.tsx`（改） | 消费 `scrollToId`：锚点 + 滚动 + flash |
| `packages/web/src/components/Shell.tsx`（改） | 透传 `searchJump`/`pendingScrollTo` 到 Sidebar/MessageList |
| `packages/web/src/styles.css`（改） | `.msg-anchor.flash` 高亮动画 + 搜索结果样式 |

---

## Task 1: 抽出共享的 `stripUserStamp`

把目前私有于 `SessionManager.ts` 的 `USER_STAMP_RE`/`stripUserStamp` 提到独立模块，供 SearchService 复用。纯重构，行为不变，由现有 SessionManager 测试守护。

**Files:**
- Create: `packages/server/src/session/userStamp.ts`
- Modify: `packages/server/src/session/SessionManager.ts`（删本地定义、改 import）

- [ ] **Step 1: 新建共享模块**

`packages/server/src/session/userStamp.ts`:
```ts
/**
 * submit() 给模型的 user 文本加 `[YYYY-MM-DD HH:MM] ` 前缀。需要还原原始提问的消费者
 * (projectMessages 显示、retry 重发、S4 历史搜索) 都经这一份定义剥除，格式只活在一处。
 */
export const USER_STAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /
export function stripUserStamp(text: string): string {
  return text.replace(USER_STAMP_RE, '')
}
```

- [ ] **Step 2: SessionManager 改用共享件**

在 `packages/server/src/session/SessionManager.ts` 删除本地的 `USER_STAMP_RE` 常量与 `stripUserStamp` 函数定义（约 71 行），在文件 import 区加：
```ts
import { stripUserStamp } from './userStamp.js'
```
（其余调用点 `stripUserStamp(...)` 不变。）

- [ ] **Step 3: 类型检查 + 跑 SessionManager 测试**

Run: `pnpm -r typecheck && pnpm vitest run packages/server/src/session/SessionManager.test.ts`
Expected: typecheck 通过；SessionManager 测试全过（行为未变）。

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/session/userStamp.ts packages/server/src/session/SessionManager.ts
git commit -m "refactor(server): extract stripUserStamp to a shared module"
```

---

## Task 2: 协议类型

**Files:**
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: 追加类型**

在 `packages/protocol/src/index.ts` 末尾追加：
```ts
/** 一条命中的高亮片段：命中处前后各截一段，match 为命中原文（保留大小写）。 */
export interface SearchSnippet {
  pre: string
  match: string
  post: string
}

/** 一条消息级命中。 */
export interface SearchHit {
  msgIndex: number
  role: 'user' | 'assistant'
  snippet: SearchSnippet
}

/** 一个会话内的搜索结果（命中按会话分组）。 */
export interface SessionSearchResult {
  session: { id: string; title: string; cwd: string; updatedAt: string }
  /** 已封顶的命中列表（最多 perSessionCap 条）。 */
  hits: SearchHit[]
  /** 该会话总命中数；可能 > hits.length。 */
  hitCount: number
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -r typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): add S4 search result types"
```

---

## Task 3: `SearchService`（核心）

TDD：先写单测，再实现。

**Files:**
- Create: `packages/server/src/search/SearchService.test.ts`
- Create: `packages/server/src/search/SearchService.ts`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/search/SearchService.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SearchService } from './SearchService.js'

let dir: string

/** 写一个最小会话记录文件到 dir。messages 用 [role, text|blocks] 简写。 */
function writeSession(id: string, updatedAt: string, messages: unknown[], extra: Record<string, unknown> = {}): void {
  const rec = {
    version: 1, id, title: 't-' + id, cwd: '/work', createdAt: updatedAt, updatedAt,
    messages, totalUsage: {}, checkpoints: [], ...extra,
  }
  writeFileSync(join(dir, id + '.json'), JSON.stringify(rec), 'utf8')
}
const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const asstMsg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-search-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SearchService', () => {
  it('命中 user 与 assistant 人话,结果定位到消息并带片段', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('请帮我做 compaction 阈值调整'), asstMsg('好的,阈值改成 90%')])
    const svc = new SearchService({ dir })
    const r = await svc.search('compaction')
    expect(r).toHaveLength(1)
    expect(r[0]!.session.id).toBe('s1')
    expect(r[0]!.hits).toHaveLength(1)
    expect(r[0]!.hits[0]!).toMatchObject({ msgIndex: 0, role: 'user' })
    expect(r[0]!.hits[0]!.snippet.match).toBe('compaction')
  })

  it('大小写无关 + 中文子串', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [asstMsg('Compaction 把上下文压缩了')])
    const svc = new SearchService({ dir })
    expect(await svc.search('COMPACTION')).toHaveLength(1)
    expect((await svc.search('压缩'))[0]!.hits[0]!.snippet.match).toBe('压缩')
  })

  it('排除 tool_use / tool_result / system,只搜人话', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'grep needle' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'needle in output' }] },
      { role: 'system', content: [{ type: 'text', text: 'needle notice' }] },
    ])
    const svc = new SearchService({ dir })
    expect(await svc.search('needle')).toHaveLength(0)
  })

  it('剥掉 user 时间戳前缀后仍按原话命中', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('[2026-06-30 10:00] 部署流程是什么')])
    const svc = new SearchService({ dir })
    expect((await svc.search('部署流程'))[0]!.hits[0]!.snippet.pre).not.toContain('2026-06-30')
  })

  it('多会话按 updatedAt 倒序;每会话命中按 msgIndex 升序', async () => {
    writeSession('old', '2026-06-29T10:00:00Z', [userMsg('apple')])
    writeSession('new', '2026-06-30T10:00:00Z', [userMsg('apple one'), asstMsg('apple two')])
    const svc = new SearchService({ dir })
    const r = await svc.search('apple')
    expect(r.map((x) => x.session.id)).toEqual(['new', 'old'])
    expect(r[0]!.hits.map((h) => h.msgIndex)).toEqual([0, 1])
  })

  it('每会话封顶 perSessionCap,hitCount 记总数', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => userMsg('match ' + i))
    writeSession('s1', '2026-06-30T10:00:00Z', msgs)
    const svc = new SearchService({ dir })
    const r = await svc.search('match', { perSessionCap: 3 })
    expect(r[0]!.hits).toHaveLength(3)
    expect(r[0]!.hitCount).toBe(8)
  })

  it('空/空白 q 返回 []', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('anything')])
    const svc = new SearchService({ dir })
    expect(await svc.search('')).toEqual([])
    expect(await svc.search('   ')).toEqual([])
  })

  it('损坏文件跳过,不影响其余结果', async () => {
    writeSession('good', '2026-06-30T10:00:00Z', [userMsg('findme')])
    writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8')
    const svc = new SearchService({ dir })
    expect(await svc.search('findme')).toHaveLength(1)
  })

  it('mtime 不变则复用缓存,不重新读文件', async () => {
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('cacheme')])
    const svc = new SearchService({ dir })
    await svc.search('cacheme')
    const spy = vi.spyOn(await import('node:fs/promises'), 'readFile')
    await svc.search('cacheme') // 第二次:mtime 命中,不应再 readFile 该文件
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/server/src/search/SearchService.test.ts`
Expected: FAIL（`SearchService` 模块不存在）。

- [ ] **Step 3: 实现 `SearchService`**

`packages/server/src/search/SearchService.ts`:
```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/server/src/search/SearchService.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/search/SearchService.ts packages/server/src/search/SearchService.test.ts
git commit -m "feat(server): SearchService — cross-session prose search (scan + mtime cache)"
```

---

## Task 4: `GET /api/search` 端点 + deps 接线

**Files:**
- Modify: `packages/server/src/http/server.ts`（`RequestHandlerDeps` + 路由）
- Modify: `packages/server/src/startServer.ts`（构造并注入）
- Modify: `packages/server/src/http/server.test.ts`（路由测试 + fake deps）
- Modify: `packages/server/src/http/static.test.ts`（fake deps 补 `search`）

- [ ] **Step 1: 写路由测试（失败）**

在 `packages/server/src/http/server.test.ts` 加（与现有 `/api/memory` 测试同风格；其辅助 `authedFetch`/`base` 按文件现有写法）：
```ts
describe('GET /api/search', () => {
  it('未登录 401', async () => {
    const r = await fetch(base + '/api/search?q=x')
    expect(r.status).toBe(401)
  })
  it('带 q 返回分组结果;空 q 返回 []', async () => {
    // 复用本文件已有的登录辅助拿到 cookie（参照 /api/memory 测试）。
    const cookie = await loginCookie() // 若文件无此辅助,用其现有等价方式
    const empty = await (await fetch(base + '/api/search?q=', { headers: { cookie } })).json()
    expect(empty).toEqual([])
    const res = await fetch(base + '/api/search?q=anything', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})
```
> 注：`server.test.ts` 已有登录/cookie 辅助（`/api/memory` 测试用过）；复用同一套，不要新造。fake deps 见 Step 4。

- [ ] **Step 2: `RequestHandlerDeps` 加 `search`**

`packages/server/src/http/server.ts`，在 `RequestHandlerDeps` 接口加一行（import `SearchService`）：
```ts
import { SearchService } from '../search/SearchService.js'
// ...
export interface RequestHandlerDeps {
  auth: AuthProvider
  service: SessionService
  memory: MemoryService
  search: SearchService
  persona: PersonaService
  // ...其余不变
}
```

- [ ] **Step 3: 加路由**

在 `packages/server/src/http/server.ts` 的 `/api/sessions` 路由之后、`/api/memory` 之前（或与其它 GET 路由并列）加：
```ts
// GET /api/search — 跨会话全文搜索 (S4, auth-gated). query ?q=&limit=
if (method === 'GET' && path === '/api/search') {
  if (!isAuthed(req)) {
    return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
  }
  const q = url.searchParams.get('q') ?? ''
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined
  return sendJson(res, 200, await deps.search.search(q, { limit }))
}
```

- [ ] **Step 4: 补 fake deps**

在 `packages/server/src/http/server.test.ts` 与 `packages/server/src/http/static.test.ts` 中构造 `makeRequestHandler({...})` / deps 的地方，加入一个 `search`。`server.test.ts`（真服务，用真 `SearchService`）：
```ts
import { SearchService } from '../search/SearchService.js'
// 在构造 service 的同一 dir 上:
const search = new SearchService({ dir: join(dir, 'web-sessions') })
// 放进 makeRequestHandler({ ..., search, ... })
```
`static.test.ts`（纯静态测试，给个最小 fake）：
```ts
const fakeSearch = { search: async () => [] } as unknown as SearchService
// makeRequestHandler({ ..., search: fakeSearch, ... })
```

- [ ] **Step 5: startServer 构造注入**

`packages/server/src/startServer.ts`，在 `usage`/`file` 等构造附近加（`sessionsDir` 已存在）：
```ts
import { SearchService } from './search/SearchService.js'
// ...
// 跨会话历史搜索 (S4):扫同一个 web-sessions 存储目录。
const search = new SearchService({ dir: sessionsDir })
```
并把 `search` 加进传给 `makeRequestHandler(...)` 的 deps 对象。

- [ ] **Step 6: 类型检查 + 跑测试**

Run: `pnpm -r typecheck && pnpm vitest run packages/server/src/http/server.test.ts packages/server/src/http/static.test.ts`
Expected: typecheck 通过；路由测试全过。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/http/server.ts packages/server/src/startServer.ts packages/server/src/http/server.test.ts packages/server/src/http/static.test.ts
git commit -m "feat(server): GET /api/search endpoint wired to SearchService"
```

---

## Task 5: 前端搜索客户端

**Files:**
- Modify: `packages/web/src/state/session.ts`

- [ ] **Step 1: 加 `searchSessions`**

在 `packages/web/src/state/session.ts` 末尾加（复用现有 `request` 辅助）：
```ts
import type { SessionMeta, SessionSearchResult } from '@zuse/protocol'
// ↑ 把现有的 `import type { SessionMeta }` 改成同时引入 SessionSearchResult

/** GET /api/search — 跨会话全文搜索。signal 用于取消过期请求。失败抛错。 */
export async function searchSessions(q: string, signal?: AbortSignal): Promise<SessionSearchResult[]> {
  const r = await request('/api/search?q=' + encodeURIComponent(q), { signal }, 'search')
  return (await r.json()) as SessionSearchResult[]
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -r typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/state/session.ts
git commit -m "feat(web): searchSessions API client"
```

---

## Task 6: store 的 `pendingScrollTo` + `searchJump`

**Files:**
- Modify: `packages/web/src/state/store.tsx`

- [ ] **Step 1: 加状态与跳转方法**

在 `StoreProvider` 内（`currentSessionId` 等附近）加：
```tsx
// S4: 点击搜索命中后,记下要滚到的消息 DOM id。独立于 reducer state,故 attachTo 的
// dispatch({kind:'reset'}) 清空 messages 后它仍存活,待新快照消息渲染出来再被 MessageList 消费。
const [pendingScrollTo, setPendingScrollTo] = useState<string | null>(null)

/** 跳到某会话的某条消息:切会话(若需要)并标记滚动目标。msgIndex ↔ 快照消息 id 'h'+i。 */
const searchJump = (sessionId: string, msgIndex: number): void => {
  setPendingScrollTo('h' + msgIndex)
  if (sessionId !== currentSessionId) attachTo(sessionId)
}
```

- [ ] **Step 2: 暴露到 context**

在 `StoreCtx.Provider` 的 `value={{...}}` 里加 `searchJump, pendingScrollTo, clearScrollTo: () => setPendingScrollTo(null)`，并在 context 的 TypeScript 类型（`StoreContextValue` 或等价接口，本文件顶部）补：
```ts
searchJump: (sessionId: string, msgIndex: number) => void
pendingScrollTo: string | null
clearScrollTo: () => void
```

- [ ] **Step 3: 类型检查**

Run: `pnpm -r typecheck`
Expected: 通过（若有别处解构 useStore 的地方因新增字段报错，按需补；新增字段一般不破坏现有解构）。

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/state/store.tsx
git commit -m "feat(web): store pendingScrollTo + searchJump for history search"
```

---

## Task 7: MessageList 消费滚动目标 + flash 高亮

**Files:**
- Modify: `packages/web/src/components/MessageList.tsx`
- Modify: `packages/web/src/styles.css`
- Modify: `packages/web/src/components/Shell.tsx`（传入 scrollToId/onScrolled）

- [ ] **Step 1: MessageList 加 props 与滚动 effect**

`packages/web/src/components/MessageList.tsx`：在 props 接口加 `scrollToId?: string | null` 和 `onScrolled?: () => void`；在组件体加：
```tsx
useEffect(() => {
  if (!scrollToId) return
  const el = document.getElementById('msg-' + scrollToId)
  if (!el) return // 目标不在(会话被截短等):静默跳过
  el.scrollIntoView({ block: 'center' })
  el.classList.add('flash')
  const t = setTimeout(() => el.classList.remove('flash'), 1500)
  onScrolled?.()
  return () => clearTimeout(t)
}, [scrollToId, messages, onScrolled])
```

- [ ] **Step 2: 给每条消息加锚点 id**

在 `MessageList` 的 `visible.map((m) => {...})` 内，非 share 分支当前 `return msgEl` 改为包一层锚点：
```tsx
return <div id={'msg-' + m.id} className="msg-anchor" key={m.id}>{msgEl}</div>
```
share 分支的最外层 `<label key={m.id} ...>` 加 `id={'msg-' + m.id}`。

- [ ] **Step 3: 加 flash 样式**

在 `packages/web/src/styles.css` 末尾加：
```css
@keyframes msg-flash { from { background: rgba(255, 214, 102, 0.35); } to { background: transparent; } }
.msg-anchor.flash, .msg-row.flash { animation: msg-flash 1.5s ease-out; border-radius: 8px; }
```

- [ ] **Step 4: Shell 透传**

`packages/web/src/components/Shell.tsx`：从 `useStore()` 解构出 `pendingScrollTo, clearScrollTo`（连同已有的），给 `<MessageList ... />` 传 `scrollToId={pendingScrollTo} onScrolled={clearScrollTo}`。

- [ ] **Step 5: 类型检查 + 构建前端**

Run: `pnpm -r typecheck`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/MessageList.tsx packages/web/src/styles.css packages/web/src/components/Shell.tsx
git commit -m "feat(web): MessageList scrolls to + flashes a target message"
```

---

## Task 8: Sidebar 搜索框 + 结果模式 + 点击跳转

TDD：先扩 `Sidebar.test.tsx`，再改组件。

**Files:**
- Modify: `packages/web/src/components/Sidebar.tsx`
- Modify: `packages/web/src/components/Sidebar.test.tsx`
- Modify: `packages/web/src/components/Shell.tsx`（给 Sidebar 传 `onJump`）

- [ ] **Step 1: 写失败的前端测试**

在 `packages/web/src/components/Sidebar.test.tsx` 加（沿用文件现有的 render/测试库；mock `searchSessions`）：
```tsx
import { vi } from 'vitest'
vi.mock('../state/session.js', async (orig) => ({
  ...(await orig<typeof import('../state/session.js')>()),
  searchSessions: vi.fn(async () => [
    { session: { id: 's1', title: '会话一', cwd: '/work', updatedAt: '2026-06-30T10:00:00Z' },
      hits: [{ msgIndex: 2, role: 'user', snippet: { pre: '前', match: 'needle', post: '后' } }], hitCount: 1 },
  ]),
}))

it('输入后进入结果模式并渲染命中片段', async () => {
  // render(<Sidebar ... onJump={...} />) — props 按组件最终签名
  // 在搜索框输入 'needle',等待防抖后断言出现 '会话一' 与 'needle'
})

it('点击命中调用 onJump(sessionId, msgIndex)', async () => {
  const onJump = vi.fn()
  // render Sidebar with onJump; 输入 'needle'; 点击命中行; 断言:
  // expect(onJump).toHaveBeenCalledWith('s1', 2)
})

it('清空搜索框恢复会话列表', async () => {
  // 输入再清空,断言会话列表(props.sessions 的标题)重新出现
})
```
> 用 `@testing-library/react` 的 `render`/`fireEvent`/`waitFor`，与文件现有用法一致。防抖用 `waitFor` 等结果出现即可（或 `vi.useFakeTimers`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/web/src/components/Sidebar.test.tsx`
Expected: FAIL（搜索框/结果模式尚未实现）。

- [ ] **Step 3: 实现 Sidebar 搜索态**

`packages/web/src/components/Sidebar.tsx`：在 `Props` 加 `onJump: (sessionId: string, msgIndex: number) => void`。组件顶部加搜索态：
```tsx
import { useEffect, useRef, useState } from 'react'
import type { SessionMeta, SessionSearchResult } from '@zuse/protocol'
import { searchSessions } from '../state/session.js'
// ...
const [query, setQuery] = useState('')
const [results, setResults] = useState<SessionSearchResult[] | null>(null)
const [searchErr, setSearchErr] = useState(false)
const reqSeq = useRef(0)

useEffect(() => {
  const q = query.trim()
  if (q === '') { setResults(null); setSearchErr(false); return }
  const seq = ++reqSeq.current
  const ac = new AbortController()
  const t = setTimeout(() => {
    void searchSessions(q, ac.signal)
      .then((r) => { if (seq === reqSeq.current) { setResults(r); setSearchErr(false) } })
      .catch(() => { if (seq === reqSeq.current) { setSearchErr(true); setResults([]) } })
  }, 200)
  return () => { clearTimeout(t); ac.abort() }
}, [query])
```
在列表渲染上方加搜索框；当 `results !== null` 时渲染结果模式、否则渲染原会话列表：
```tsx
<input
  className="session-search"
  placeholder="搜索历史…"
  value={query}
  onChange={(e) => setQuery(e.target.value)}
/>
{results !== null ? (
  <div className="search-results">
    {searchErr ? <div className="search-empty">搜索失败</div>
      : results.length === 0 ? <div className="search-empty">无匹配</div>
      : results.map((r) => (
        <div key={r.session.id} className="search-group">
          <div className="search-group-head">{r.session.title || 'New chat'}</div>
          {r.hits.map((h) => (
            <button
              key={r.session.id + ':' + h.msgIndex}
              className="search-hit"
              onClick={() => onJump(r.session.id, h.msgIndex)}
            >
              <span className="hit-role">{h.role === 'user' ? '你' : 'zuse'}</span>
              <span className="hit-snippet">
                {h.snippet.pre}<mark>{h.snippet.match}</mark>{h.snippet.post}
              </span>
            </button>
          ))}
          {r.hitCount > r.hits.length ? <div className="search-more">还有 {r.hitCount - r.hits.length} 条</div> : null}
        </div>
      ))}
  </div>
) : (
  /* 原有会话列表 <ul> ... </ul> 保持不变 */
)}
```

- [ ] **Step 4: Shell 给 Sidebar 传 onJump**

`packages/web/src/components/Shell.tsx`：从 `useStore()` 取 `searchJump`，给 `<Sidebar ... onJump={(id, idx) => { void searchJump(id, idx); setMenuOpen(false) }} />`。

- [ ] **Step 5: 加结果样式（可选最小）**

在 `packages/web/src/styles.css` 加基础样式（不追求精致，够用即可）：
```css
.session-search { width: 100%; box-sizing: border-box; margin: 8px 0; padding: 6px 8px; }
.search-group-head { font-size: 12px; opacity: .7; margin: 8px 0 2px; }
.search-hit { display: flex; gap: 6px; width: 100%; text-align: left; background: none; border: 0; padding: 4px 6px; cursor: pointer; }
.search-hit:hover { background: rgba(127,127,127,.12); }
.hit-role { font-size: 11px; opacity: .6; flex: none; }
.hit-snippet { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-hit mark { background: rgba(255,214,102,.45); }
.search-more, .search-empty { font-size: 12px; opacity: .6; padding: 4px 6px; }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run packages/web/src/components/Sidebar.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 7: 类型检查 + Commit**

Run: `pnpm -r typecheck`
```bash
git add packages/web/src/components/Sidebar.tsx packages/web/src/components/Sidebar.test.tsx packages/web/src/components/Shell.tsx packages/web/src/styles.css
git commit -m "feat(web): sidebar history search box + results + jump-to-message"
```

---

## Task 9: 全量校验

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `pnpm -r typecheck && pnpm vitest run`
Expected: typecheck 6/6 通过；新增测试全过。**注意**：以下为改动前就存在的环境性失败，非本次引入，可忽略——`bash.test`（Windows shell 快照）、`skills.test`（scanSkills 临时目录）、`anthropic-client`（需 API key 的 live 测试）、`wsServer`（全量并行下真起 WS 服务的 5s 超时；单独跑全过）。

- [ ] **Step 2: lint 改动文件**

Run: `npx eslint packages/server/src/search packages/server/src/session/userStamp.ts packages/web/src/components/Sidebar.tsx packages/web/src/components/MessageList.tsx`
Expected: 0 error（test 文件里既有的 `@ts-expect-error` 描述告警与本任务无关）。

- [ ] **Step 3: 手动验收（可选，按 /run 或 dev 起前端）**

启动 Web，侧边栏搜一个你说过的词 → 出现分组结果 → 点击 → 跳到对应会话并滚动 + flash。

---

## 自审记录（spec 覆盖核对）

- §1–§5 产品决策（搜人话/消息级/侧边栏/全局/扫描方案）→ Task 3（服务）+ Task 8（UI）+ Task 4（端点）。
- §4.1 mtime 缓存复用 → Task 3 Step 1 的缓存测试 + Step 3 实现。
- §6.2 跳转 id 映射（'h'+msgIndex）→ Task 6（searchJump）+ Task 7（MessageList 消费）。spec 标注的"实现时复核映射"→ Task 7 手动验收 + 若错位的兜底（让快照消息带 ledgerIndex）留给执行者按现象决定。
- §7 边界（空 q / 损坏文件 / 封顶 / 跳转目标不存在）→ Task 3 测试 + Task 7 effect 的 `if (!el) return`。
- §8 测试矩阵 → Task 3 / Task 4 / Task 8 测试步骤逐项对应。
- 前置（stripUserStamp 私有）→ Task 1。
