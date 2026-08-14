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

/** MEMORY.md 投影写盘(工具闭包与巩固应用共用):best-effort,失败不丢数据。 */
function writeProjection(store: MemoryStore, mdPath?: string): void {
  try {
    writeFileSync(mdPath ?? defaultMemoryMdPath(), renderMemoryMarkdown(store.all()), 'utf8')
  } catch {
    // 投影只是缓存,下次变更会重试。
  }
}

/** 自动巩固的操作集(core parseConsolidationOps 的输出形状)。 */
export interface ConsolidationApplyOps {
  deletes: number[]
  saves: Array<{ type: MemoryType; hook: string; content: string }>
}

/**
 * 应用自动巩固操作(Phase 13,轻量 autoDream):save 在前、delete 在后 ——
 * 合并的新条目先落地,中途失败也不丢旧数据;完成后重投影一次。
 * **有意绕过满容闸**:巩固是净收缩操作,在接近满容时恰恰最需要执行,
 * 走工具的 save 会被 ④ 的闸拒掉。
 */
export function applyMemoryConsolidation(
  ops: ConsolidationApplyOps,
  project: string,
  opts: MemoryToolOptions = {},
): { saved: number; deleted: number } {
  const store = openMemoryStore(opts.dbPath)
  try {
    let saved = 0
    for (const s of ops.saves) {
      if (!s.content) continue
      store.save(s.type, s.content, s.type === 'user' ? '' : project, s.hook)
      saved++
    }
    let deleted = 0
    for (const id of ops.deletes) {
      if (store.remove(id)) deleted++
    }
    if (saved || deleted) writeProjection(store, opts.memoryMdPath)
    return { saved, deleted }
  } finally {
    store.close()
  }
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
    writeProjection(getStore(), opts.memoryMdPath)
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
When to save (do this proactively):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover a stable convention, tool quirk, or workflow specific to this project
- You learn something from a correction that will apply to future sessions
Save sparingly: durable facts only (preferences, constraints, corrections). Do NOT save task progress, session outcomes, completed-work logs, PR numbers, issue numbers, commit SHAs, or any artifact that will be stale in a week. If it won't matter next month, it does not belong in memory.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'recall', 'list', 'delete'] },
        type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Required for save: memory type' },
        content: { type: 'string', description: 'Required for save: the fact to remember' },
        hook: { type: 'string', description: 'Optional for save: one-line gist used as MEMORY.md index entry; required when content is longer than a sentence or two' },
        query: { type: 'string', description: 'Required for search/recall: search terms' },
        id: { type: 'number', description: 'Required for delete: memory id' },
        days: { type: 'number', description: 'Optional for recall: only search sessions updated in the last N days' },
      },
      required: ['action'],
    },
    /**
     * **保留 `readOnly: true`，但写入面另由内置 ask 规则管住。**
     *
     * 原来的理由是「写入面 = zuse 自有库，不碰用户工作区」—— 那句话漏了这个工具
     * **自己的描述**里就写着的一件事：`an index of them (MEMORY.md) is loaded into
     * your system prompt at session start`。也就是说 `save` 写的东西会进入机主
     * **此后每一个会话的系统提示词**，而 `readOnly` 让它在 default 档**不弹框**
     *（`decide` 末尾是 `tool.readOnly ? 'allow' : 'ask'`）。
     * 一次提示注入即可把「以后遇到 X 就执行 Y」永久写进去。
     *
     * **为什么不干脆翻成 `false`**：`readOnly` 是工具级静态属性，翻了之后
     * `search`/`recall`/`list` 也一起弹框（噪音换不到安全），而且会把 Memory 踢出
     * 同轮工具的并发批（`agent.ts` 用 `readOnly || parallelizable` 决定能否并发）——
     * 那与安全性毫无关系。所以改用**限定符 + 内置 ask 规则**，只管住写的两个 action。
     */
    // **2026-08-14 设计审计翻掉了这里原来的 `readOnly: true`。**
    //
    // 原来的理由有两半，现在两半都不成立：
    //   ①「翻成 false 会把 Memory 踢出同轮并发批」—— `parallelizable` 这个字段就是
    //      为了解耦这件事而存在的（tool.ts 注释原话：「与 readOnly 正交，仍照常过权限闸」），
    //      所以并发用 parallelizable 表达，不该借 readOnly。
    //   ②「翻成 false 会让读类 action 也弹框」—— 改用三条显式 allow 规则解决
    //      （DEFAULT_ALLOW_RULES 里的 Memory(search/recall/list)），噪音完全一样。
    //
    // 而 `readOnly: true` 的形状是 **fail-open**：`decide()` 的兜底是
    // `readOnly ? 'allow' : 'ask'`，于是**任何不在 DEFAULT_ASK_RULES 里的 action 自动放行**。
    // 今天 action 枚举 5 个、ask 表 2 个；明天加第 6 个写类 action ——
    // 编译不报错、测试不变红、界面不弹框。这正是 CLAUDE.md 那条「用标记不用清单」
    // 要防的形状（`sessionScoped` 已经用标记解决过一次，这里当时退回了清单）。
    readOnly: false,
    parallelizable: true,
    /**
     * 限定符 = action，配合 `DEFAULT_ASK_RULES` 里的 `Memory(save)` / `Memory(delete)`。
     *
     * **`specifierKind` 必须是 `'opaque'`**：不标的话限定符会被当**路径**
     * `resolve(cwd, 'save')` 再判 cwd 围栏。干净 cwd 下碰巧能命中，但评审实测
     * ——cwd 里只要有一个名叫 `save` 的符号链接指向外部，`realpath` 一解就逃出围栏、
     * 规则**静默失效**。同 WebFetch 主机名那条先例。
     */
    specifierKind: 'opaque',
    specifierFor: (input: unknown) => {
      const a = (input as { action?: unknown } | null)?.action
      return typeof a === 'string' ? a : null
    },

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
          // 写入时刻的矛盾轻推:用新内容反查相近旧记忆,列在返回里提醒清理。
          // 实测(deepseek)模型存新记忆时不会主动想起删旧的 —— 而这一刻恰恰是
          // 它最清楚「旧的哪条已过时」的时刻;等自动巩固要到索引快满才触发。
          const related = s
            .search(content, project)
            .filter((r) => r.id !== row.id)
            .slice(0, 3)
          if (related.length > 0) {
            return {
              output:
                `Saved memory [${row.id}] (${row.type}).\n` +
                `ACTION REQUIRED — existing memories overlap with what you just saved:\n${related.map(formatRow).join('\n')}\n` +
                'Review each one NOW, before responding to the user: if it is contradicted or superseded by the new memory, ' +
                'call this tool again with action "delete" and its id. Never tell the user a memory was deleted unless you actually called delete.',
            }
          }
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
            lines.push(`[${h.at.slice(0, 16).replace('T', ' ')} session ${h.sessionId}]`)
            for (const c of h.context) {
              lines.push(c.anchor ? `▶ ${c.role}: ${h.snippet || c.text}` : `  ${c.role}: ${c.text}`)
            }
          }
          lines.push('(Use /resume <session-id> to reopen the full conversation)')
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

export const toolModule = {
  make: (o) => createMemoryTool(o.memoryProject ?? ''),
} satisfies import('./tool-module.js').ToolModule
