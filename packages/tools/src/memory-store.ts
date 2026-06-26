/**
 * 记忆库(Phase 13B)—— SQLite + FTS5,跨会话的结构化记忆存储。
 *
 * 选型:better-sqlite3(成熟的原生 SQLite 绑定,FTS5 已编译进)。
 * 早期用过 Node 22 内置 node:sqlite,但它一直是实验性 API,每次启动打
 * ExperimentalWarning,且 Node 版本升级有 API 变更风险。better-sqlite3 的 API
 * 更稳定,社区更成熟,虽然需要 node-gyp 编译(prebuild 覆盖了主流平台)。
 *
 * 单库多项目(spec D7):`~/.zuse/memory.db` 一个文件,`project` 列区分归属
 * (cwd-slug;空串 = 全局)。user 型记忆天然全局,跨项目共享。
 *
 * 中文检索:FTS5 用 trigram 分词器(unicode61 会把连续中文当一个 token,词内
 * 检索必然落空)。trigram 要求查询 ≥3 字符,两字中文词(高频!)命中不了 ——
 * 短查询或 FTS 零命中时回退 LIKE 子串匹配,两头兜住。
 *
 * 设计见 docs/superpowers/specs/2026-06-12-zuse-project-memory-design.md。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

export type MemoryType = 'user' | 'project' | 'insight' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'project', 'insight', 'reference']

export interface MemoryRow {
  id: number
  type: MemoryType
  content: string
  /** cwd-slug;空串 = 全局(所有项目可见)。 */
  project: string
  /**
   * 索引行钩子:保存者(模型)写的一行式摘要,MEMORY.md 投影优先用它。
   * 机械掐正文前缀会让「要点在 120 字符之后」的记忆在索引里不可发现;
   * 写记忆的那一刻最清楚这条的要点是什么 —— 钩子由作者给,不靠机器猜。
   */
  hook: string
  createdAt: string
  updatedAt: string
}

export interface MemoryStore {
  /** 保存一条记忆,返回完整行。project 空串 = 全局;hook 为索引行钩子(可空,投影回退正文前缀)。 */
  save(type: MemoryType, content: string, project: string, hook?: string): MemoryRow
  /** 全文检索,范围 = 指定项目 ∪ 全局。 */
  search(query: string, project: string, limit?: number): MemoryRow[]
  /** 列出指定项目 ∪ 全局的全部记忆。 */
  list(project: string): MemoryRow[]
  /**
   * 原地更新一条记忆(保 id/createdAt 不变,刷新 updatedAt;FTS 由 memories_au 触发器同步)。
   * 只改传入的字段;未命中(无此 id)返回 null,否则查回整行返回。
   */
  update(id: number, fields: { type?: MemoryType; content?: string; hook?: string; project?: string }): MemoryRow | null
  /** 删除;未命中返回 false。 */
  remove(id: number): boolean
  /** 全量(MEMORY.md 投影用),id 升序。 */
  all(): MemoryRow[]
  /** 元数据(如上次巩固时间);不存在返回 null。 */
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  close(): void
}

/** 缺省库路径(测试经 ZUSE_MEMORY_DB 或显式参数注入)。 */
function defaultDbPath(): string {
  return process.env.ZUSE_MEMORY_DB ?? join(homedir(), '.zuse', 'memory.db')
}

/**
 * FTS5 查询词项清洗(spec D6):按空白拆词、剥掉内部双引号、每词加引号、OR 连接。
 * FTS5 的语法字符(AND、OR、NOT、星号、减号、引号)直接拼必抛 syntax error,
 * 中文短语更是必炸;引号包裹后一律按字面词项处理。
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
  return terms.map((t) => `"${t}"`).join(' OR ')
}

interface RawRow {
  id: number
  type: string
  content: string
  project: string
  hook: string
  created_at: string
  updated_at: string
}

function toRow(r: RawRow): MemoryRow {
  return {
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    project: r.project,
    hook: r.hook,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function openMemoryStore(dbPath = defaultDbPath()): MemoryStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  // 迁移:Phase 13 初版的表没有 hook 列,老库重开时补列(默认空串,投影回退前缀)。
  // CREATE TABLE IF NOT EXISTS 对已存在的表不生效,必须显式 ALTER。
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()
  if (hasTable) {
    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'hook')) {
      db.exec("ALTER TABLE memories ADD COLUMN hook TEXT NOT NULL DEFAULT ''")
    }
  }
  // schema 幂等:IF NOT EXISTS 全套,重开同一文件直接复用。
  db.exec(`
    -- AUTOINCREMENT:id 单调、绝不复用被删的值。记忆按 id 被模型引用(对话里、
    -- MEMORY.md 投影里),复用会让旧引用悄悄指向另一条记忆。
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('user','project','insight','reference')),
      content TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      hook TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    -- 元数据键值(上次自动巩固时间等水位)。
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  return {
    save(type, content, project, hook = '') {
      const now = new Date().toISOString()
      const res = db
        .prepare(
          'INSERT INTO memories (type, content, project, hook, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(type, content, project, hook, now, now)
      const id = Number(res.lastInsertRowid)
      return { id, type, content, project, hook, createdAt: now, updatedAt: now }
    },

    search(query, project, limit = 10) {
      const fts = sanitizeFtsQuery(query)
      let rows: RawRow[] = []
      if (fts) {
        try {
          rows = db
            .prepare(
              `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
               WHERE memories_fts MATCH ? AND (m.project = ? OR m.project = '')
               ORDER BY rank LIMIT ?`,
            )
            .all(fts, project, limit) as unknown as RawRow[]
        } catch {
          rows = [] // 清洗后仍极端非法的查询:按零命中走 LIKE 回退,不向上抛
        }
      }
      if (rows.length === 0) {
        // 短查询(trigram 需 ≥3 字符,两字中文词命中不了)或 FTS 零命中:LIKE 子串兜底。
        const term = query.trim()
        if (term) {
          rows = db
            .prepare(
              `SELECT * FROM memories
               WHERE content LIKE ? AND (project = ? OR project = '')
               ORDER BY id DESC LIMIT ?`,
            )
            .all(`%${term}%`, project, limit) as unknown as RawRow[]
        }
      }
      return rows.map(toRow)
    },

    list(project) {
      const rows = db
        .prepare(`SELECT * FROM memories WHERE project = ? OR project = '' ORDER BY id`)
        .all(project) as unknown as RawRow[]
      return rows.map(toRow)
    },

    update(id, fields) {
      // 动态拼 SET 子句:只改传入的字段,updated_at 永远刷新。空 fields 也至少刷 updated_at,
      // 仍以 changes 判存在性(WHERE id=? 命中即 changes>0,未命中 0 → null)。
      const sets: string[] = []
      const params: unknown[] = []
      if (fields.type !== undefined) {
        sets.push('type = ?')
        params.push(fields.type)
      }
      if (fields.content !== undefined) {
        sets.push('content = ?')
        params.push(fields.content)
      }
      if (fields.hook !== undefined) {
        sets.push('hook = ?')
        params.push(fields.hook)
      }
      if (fields.project !== undefined) {
        sets.push('project = ?')
        params.push(fields.project)
      }
      sets.push('updated_at = ?')
      params.push(new Date().toISOString())
      params.push(id)
      const res = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]))
      if (Number(res.changes) === 0) return null
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as RawRow
      return toRow(row)
    },

    remove(id) {
      const res = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      return Number(res.changes) > 0
    },

    all() {
      const rows = db.prepare('SELECT * FROM memories ORDER BY id').all() as unknown as RawRow[]
      return rows.map(toRow)
    },

    getMeta(key) {
      const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value ?? null
    },

    setMeta(key, value) {
      db.prepare(
        'INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value)
    },

    close() {
      db.close()
    },
  }
}

/**
 * 记忆年龄标注(对齐 CC 的 memoryAge):≥1 天才标。旧记忆按当下状态行动前该核对
 * 时效 —— 「三个月前的约定」和「昨天的约定」对模型的置信度应该不同。
 * now 可注入,纯函数便于测试。
 */
export function memoryAgeNote(createdAt: string, now = Date.now()): string {
  const ts = Date.parse(createdAt)
  if (!Number.isFinite(ts)) return ''
  const days = Math.floor((now - ts) / 86_400_000)
  return days >= 1 ? `${days} 天前` : ''
}

/** 投影里单条内容的展示上限。 */
const PROJECTION_LINE_CAP = 120

/**
 * MEMORY.md 投影(Phase 13D):按类型分组、每条一行带 id。db 是唯一真相源,
 * 此文件是生成物 —— 头部注明改了会被覆盖。
 */
export function renderMemoryMarkdown(rows: MemoryRow[], now = Date.now()): string {
  const header =
    '<!-- 自动生成:此文件是 ~/.zuse/memory.db 的投影,手工修改会在下次记忆变更时被覆盖。 -->\n# Memory\n'
  if (rows.length === 0) {
    return `${header}\n(还没有任何记忆。模型可用 Memory 工具保存。)\n`
  }
  const oneLine = (r: MemoryRow): string => {
    // 钩子优先:作者(模型)在保存时最清楚这条记忆的要点;机械掐正文前缀会让
    // 「要点在截断之后」的记忆在索引里不可发现。无钩子(旧数据)回退前缀截断。
    const flat = (r.hook || r.content).replace(/\s+/g, ' ').trim()
    const capped = flat.length > PROJECTION_LINE_CAP ? flat.slice(0, PROJECTION_LINE_CAP) + '…' : flat
    const scope = r.project ? ` (${r.project})` : ''
    const age = memoryAgeNote(r.createdAt, now)
    return `- [${r.id}] ${capped}${scope}${age ? ` · ${age}` : ''}`
  }
  const groups = MEMORY_TYPES.filter((t) => rows.some((r) => r.type === t)).map((t) => {
    const lines = rows.filter((r) => r.type === t).map(oneLine)
    return `\n## ${t}\n${lines.join('\n')}`
  })
  return header + groups.join('\n') + '\n'
}
