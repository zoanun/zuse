/**
 * Memory 工具(Phase 13C)—— 模型的跨会话记忆操作入口。
 *
 * 单工具带 action(save/search/list/delete),而非四个工具:工具清单已不短,
 * 记忆操作语义内聚。`readOnly: true` 是有意拉伸(spec D3):权限闸里 readOnly 的
 * 实质语义 = 不触碰用户工作区、无需确认、可并发 —— Memory 的写入只落 zuse 自有
 * 数据库(~/.zuse/memory.db),不碰项目文件、不动 cwd、不竞争文件锁,三条全符合;
 * 若每次 save 都弹确认,模型就不会save,功能等于没做。
 *
 * save/delete 成功后同步重建 MEMORY.md 投影(Phase 13D):db 是唯一真相源,
 * 投影失败不影响记忆操作本身(best-effort)。
 */
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_INDEX_CAP, type Tool, type ToolResult } from '@zuse/core'
import {
  openMemoryStore,
  renderMemoryMarkdown,
  memoryAgeNote,
  MEMORY_TYPES,
  type MemoryStore,
  type MemoryType,
  type MemoryRow,
} from './memory-store.js'
import { openEpisodeStore, type EpisodeStore } from './episode-store.js'

/** MEMORY.md 投影落点(测试经 ZUSE_MEMORY_MD 或 opts 注入)。 */
function defaultMemoryMdPath(): string {
  return process.env.ZUSE_MEMORY_MD ?? join(homedir(), '.zuse', 'MEMORY.md')
}

export interface MemoryToolOptions {
  /** 记忆库文件路径(缺省 ~/.zuse/memory.db;测试注入)。 */
  dbPath?: string
  /** MEMORY.md 投影路径(缺省 ~/.zuse/MEMORY.md;测试注入)。 */
  memoryMdPath?: string
  /** 会话存放根(recall 检索历史会话用;缺省 ZUSE_SESSIONS_DIR 或 ~/.zuse/sessions)。 */
  sessionsDir?: string
}

interface MemoryInput {
  action?: unknown
  type?: unknown
  content?: unknown
  hook?: unknown
  query?: unknown
  id?: unknown
  days?: unknown
}

function formatRow(r: MemoryRow): string {
  const scope = r.project ? '' : ' (global)'
  // 年龄标注:旧记忆提醒模型核对时效(对齐 CC 的 freshness note)。
  const age = memoryAgeNote(r.createdAt)
  return `[${r.id}] (${r.type}${scope}${age ? `, ${age}` : ''}) ${r.content}`
}

/**
 * @param project 记忆归属(会话起始 cwd 的 slug;空串 = 全局)。save 的 user 型
 *                记忆强制全局 —— 用户是谁与项目无关。
 * @returns Tool 外加 dispose():关闭底层 sqlite 连接 —— Windows 上不关文件锁不释放,
 *          测试的临时目录删不掉;生产路径随进程退出自然释放,无需调用。
 */
export function createMemoryTool(project: string, opts: MemoryToolOptions = {}): Tool & { dispose: () => void } {
  // 懒开库:不用记忆的会话完全不碰 sqlite(也不触发 node:sqlite 的 ExperimentalWarning)。
  let store: MemoryStore | null = null
  const getStore = (): MemoryStore => {
    store ??= openMemoryStore(opts.dbPath)
    return store
  }
  // 情景索引(recall)同样懒开;与语义记忆共用同一个 db 文件,表独立。
  let episodes: EpisodeStore | null = null
  const getEpisodes = (): EpisodeStore => {
    episodes ??= openEpisodeStore({ dbPath: opts.dbPath, sessionsDir: opts.sessionsDir })
    return episodes
  }

  /** 投影重建(D):best-effort,失败不影响记忆操作本身。 */
  const reproject = (): void => {
    try {
      writeFileSync(opts.memoryMdPath ?? defaultMemoryMdPath(), renderMemoryMarkdown(getStore().all()), 'utf8')
    } catch {
      // 投影只是缓存,下次变更会重试;丢一次不丢数据。
    }
  }

  return {
    dispose(): void {
      store?.close()
      store = null
      episodes?.close()
      episodes = null
    },
    name: 'Memory',
    description: `Persistent cross-session memory. Saved memories survive restarts; an index of them (MEMORY.md) is loaded into your system prompt at session start.
Actions:
- save: store a durable fact. Requires "type" and "content". Types: user = who the user is / their preferences (global across projects); project = facts and constraints of this project; insight = lessons learned and corrections received (include why); reference = pointers to external resources (URLs, docs). When "content" is longer than a sentence or two, also provide "hook": a one-line gist used as the memory's index entry — without it the index falls back to a blind prefix cut of the content.
- search: full-text search memories visible to this project (its own + global). Requires "query".
- recall: full-text search PAST CONVERSATION transcripts of this project (episodic memory — "what did we discuss about X?"). Requires "query"; optional "days" limits to sessions updated in the last N days. Returns matching excerpts with session ids; the user can reopen a session with /resume <id>.
- list: list all memories visible to this project.
- delete: remove an outdated or wrong memory by "id".
Save sparingly: durable facts only (preferences, constraints, corrections) — not transient task state, and not what the project files already record.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'recall', 'list', 'delete'] },
        type: { type: 'string', enum: [...MEMORY_TYPES], description: 'save 必填:记忆类型' },
        content: { type: 'string', description: 'save 必填:记忆内容' },
        hook: { type: 'string', description: 'save 可选:一行式要点,用作 MEMORY.md 索引行;内容较长时必给' },
        query: { type: 'string', description: 'search/recall 必填:检索词' },
        id: { type: 'number', description: 'delete 必填:记忆 id' },
        days: { type: 'number', description: 'recall 可选:只搜最近 N 天更新过的会话' },
      },
      required: ['action'],
    },
    // 有意拉伸(spec D3):写入面 = zuse 自有库,不碰用户工作区,符合 readOnly 实质语义。
    readOnly: true,

    async run(input: unknown): Promise<ToolResult> {
      const inp = (input ?? {}) as MemoryInput
      let s: MemoryStore
      try {
        s = getStore()
      } catch (err) {
        return {
          output: `Memory store unavailable: ${err instanceof Error ? err.message : String(err)}. Proceed without memory; do not retry this call.`,
          isError: true,
        }
      }

      switch (inp.action) {
        case 'save': {
          const type = inp.type
          const content = typeof inp.content === 'string' ? inp.content.trim() : ''
          if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type)) {
            return {
              output: `Invalid or missing "type". Use one of: ${MEMORY_TYPES.join(', ')}.`,
              isError: true,
            }
          }
          if (!content) {
            return { output: 'Missing "content" — provide the fact to remember.', isError: true }
          }
          const hook = typeof inp.hook === 'string' ? inp.hook.trim() : ''
          // 满容硬闸(对齐 Hermes 的容量语义):投影若将超过启动注入上限,拒绝保存、
          // 要求先整理 —— 把维护压力放在写入那一刻;静默截断会让索引悄悄丢尾部。
          const prospective = renderMemoryMarkdown([
            ...s.all(),
            {
              id: 0,
              type: type as MemoryType,
              content,
              project,
              hook,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ])
          if (prospective.length > MEMORY_INDEX_CAP) {
            return {
              output:
                `Memory index is full (${prospective.length} chars > cap ${MEMORY_INDEX_CAP}). ` +
                'Consolidate before saving: use action "list" to review, merge related memories into fewer entries ' +
                '(save the merged one, then "delete" the originals), remove obsolete ones, then retry this save.',
              isError: true,
            }
          }
          // user 型强制全局:用户是谁与当前项目无关,跨项目共享。
          const row = s.save(type as MemoryType, content, type === 'user' ? '' : project, hook)
          reproject()
          return { output: `Saved memory [${row.id}] (${row.type}).` }
        }

        case 'search': {
          const query = typeof inp.query === 'string' ? inp.query.trim() : ''
          if (!query) {
            return { output: 'Missing "query" — provide search terms.', isError: true }
          }
          const rows = s.search(query, project)
          if (rows.length === 0) {
            return { output: `No memories matched "${query}". Try different terms, or action "list" to see all.` }
          }
          return { output: rows.map(formatRow).join('\n') }
        }

        case 'recall': {
          const query = typeof inp.query === 'string' ? inp.query.trim() : ''
          if (!query) {
            return { output: 'Missing "query" — provide search terms for past conversations.', isError: true }
          }
          const days = typeof inp.days === 'number' && inp.days > 0 ? inp.days : undefined
          let hits
          try {
            hits = getEpisodes().recall(query, project, { days })
          } catch (err) {
            return {
              output: `Episode index unavailable: ${err instanceof Error ? err.message : String(err)}. Proceed without recall; do not retry this call.`,
              isError: true,
            }
          }
          if (hits.length === 0) {
            return {
              output: `No past conversation matched "${query}"${days ? ` in the last ${days} days` : ''}. Try different terms or a wider time range.`,
            }
          }
          // 每个命中渲染成一小块:标题行 + ±2 条上下文,锚点行用 ▶ 标记并展示命中片段。
          const lines: string[] = []
          for (const h of hits) {
            lines.push(`[${h.at.slice(0, 16).replace('T', ' ')} 会话 ${h.sessionId}]`)
            for (const c of h.context) {
              lines.push(c.anchor ? `▶ ${c.role}: ${h.snippet || c.text}` : `  ${c.role}: ${c.text}`)
            }
          }
          lines.push('(完整会话可用 /resume <会话id> 回看)')
          return { output: lines.join('\n') }
        }

        case 'list': {
          const rows = s.list(project)
          if (rows.length === 0) {
            return { output: '(no memories yet — use action "save" to store durable facts)' }
          }
          return { output: rows.map(formatRow).join('\n') }
        }

        case 'delete': {
          const id = typeof inp.id === 'number' ? inp.id : NaN
          if (!Number.isInteger(id)) {
            return { output: 'Missing or invalid "id" — use action "list" to find memory ids.', isError: true }
          }
          if (!s.remove(id)) {
            const ids = s.list(project).map((r) => r.id)
            return {
              output: `No memory with id ${id}. Existing ids: ${ids.length ? ids.join(', ') : '(none)'}. Use action "list" to see them.`,
              isError: true,
            }
          }
          reproject()
          return { output: `Deleted memory [${id}].` }
        }

        default:
          return {
            output: `Unknown action: ${String(inp.action)}. Use one of: save, search, recall, list, delete.`,
            isError: true,
          }
      }
    },
  }
}
