/**
 * 情景记忆索引(Phase 13.5)—— 历史会话 transcript 的全文检索。
 *
 * 与 memory-store(语义记忆:蒸馏后的结论)互补:这里回答「我们某天讨论过什么」
 * —— 检索的是对话原文。原始数据 = Phase 10A 落盘的自动会话文件
 * (`~/.zuse/sessions/auto/<slug>/<id>.json`),本模块不另存正文,只建 FTS 索引。
 *
 * 索引时机:**recall 时懒建 + 按 updatedAt 增量**(spec 13.5)。不在 autosave 时
 * 同步建 —— 那是每回合的写放大,而 recall 是低频操作;代价是首次 recall 略慢
 * (全量扫一遍本项目会话),之后只补有变化的会话。
 *
 * 索引范围:只收 user/assistant 的 text 块。tool_use/tool_result 是工具噪音
 * (动辄千行的命令输出),进了索引反而把真正的讨论淹掉。
 */
import { readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sanitizeFtsQuery } from './memory-store.js'

// 与 memory-store 同理:node:sqlite 经 process.getBuiltinModule 运行时取。
function getSqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite')
}

/** 单条消息进索引的文本上限:超长粘贴不该把索引撑爆,检索靠前缀已足够定位。 */
const MESSAGE_TEXT_CAP = 4_000

/** LIKE 回退命中时手工截片段的窗口(FTS 路径用 snippet() 内建)。 */
const LIKE_SNIPPET_BEFORE = 60
const LIKE_SNIPPET_AFTER = 90

export interface EpisodeHit {
  /** 会话 id(可用 /resume <id> 回看完整会话)。 */
  sessionId: string
  /** 会话最后更新时间(ISO;会话文件无逐条消息时间戳,时间过滤按会话粒度)。 */
  at: string
  role: string
  /** 命中片段(FTS snippet 或 LIKE 截窗)。 */
  snippet: string
}

export interface EpisodeStore {
  /** 检索历史会话原文。days 限定只搜最近 N 天更新过的会话;缺省不限。 */
  recall(query: string, slug: string, opts?: { days?: number; limit?: number }): EpisodeHit[]
  close(): void
}

export interface EpisodeStoreOptions {
  /** 索引库路径(与 memory.db 同文件共存,表独立;缺省 ~/.zuse/memory.db)。 */
  dbPath?: string
  /** 会话存放根(与 tui sessionStore 同一约定:ZUSE_SESSIONS_DIR 或 ~/.zuse/sessions)。 */
  sessionsDir?: string
}

function defaultDbPath(): string {
  return process.env.ZUSE_MEMORY_DB ?? join(homedir(), '.zuse', 'memory.db')
}

function defaultSessionsDir(): string {
  return process.env.ZUSE_SESSIONS_DIR ?? join(homedir(), '.zuse', 'sessions')
}

/** SessionRecord 里 recall 关心的子集(版本无关:只要有 updatedAt + messages 就能索引)。 */
interface SessionFile {
  updatedAt?: unknown
  messages?: unknown
}

/** 从一条消息的 content 块里抽出可索引文本(只收 text 块,工具块全跳过)。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown }
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function openEpisodeStore(opts: EpisodeStoreOptions = {}): EpisodeStore {
  const dbPath = opts.dbPath ?? defaultDbPath()
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir()
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new (getSqlite().DatabaseSync)(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      text,
      content='episodes',
      content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    -- 「某会话已索引到哪个 updatedAt」的水位表:增量同步的依据。
    CREATE TABLE IF NOT EXISTS episode_index_state (
      session_id TEXT PRIMARY KEY,
      indexed_updated_at TEXT NOT NULL
    );
  `)

  /** 增量同步某项目的会话索引:updatedAt 变了的会话整体重建(删旧插新),没变的跳过。 */
  const syncIndex = (slug: string): void => {
    let files: string[]
    try {
      files = readdirSync(join(sessionsDir, 'auto', slug)).filter((f) => f.endsWith('.json'))
    } catch {
      return // 目录不存在 = 该项目还没有会话
    }
    const stateStmt = db.prepare('SELECT indexed_updated_at FROM episode_index_state WHERE session_id = ?')
    for (const f of files) {
      const sessionId = f.slice(0, -'.json'.length)
      let record: SessionFile
      try {
        record = JSON.parse(readFileSync(join(sessionsDir, 'auto', slug, f), 'utf8')) as SessionFile
      } catch {
        continue // 损坏文件跳过,与 listAutoSessions 同策略
      }
      const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
      if (!updatedAt || !Array.isArray(record.messages)) continue
      const state = stateStmt.get(sessionId) as { indexed_updated_at: string } | undefined
      if (state?.indexed_updated_at === updatedAt) continue

      db.prepare('DELETE FROM episodes WHERE session_id = ?').run(sessionId)
      const insert = db.prepare(
        'INSERT INTO episodes (session_id, slug, msg_index, role, text, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (let i = 0; i < record.messages.length; i++) {
        const m = record.messages[i] as { role?: unknown; content?: unknown }
        if (m.role !== 'user' && m.role !== 'assistant') continue
        const text = extractText(m.content)
        if (!text) continue // 纯工具消息(tool_use/tool_result)无文本,不进索引
        insert.run(sessionId, slug, i, m.role, text.slice(0, MESSAGE_TEXT_CAP), updatedAt)
      }
      db.prepare(
        `INSERT INTO episode_index_state (session_id, indexed_updated_at) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET indexed_updated_at = excluded.indexed_updated_at`,
      ).run(sessionId, updatedAt)
    }
  }

  return {
    recall(query, slug, recallOpts = {}) {
      syncIndex(slug)
      const limit = recallOpts.limit ?? 8
      const cutoff = recallOpts.days
        ? new Date(Date.now() - recallOpts.days * 86_400_000).toISOString()
        : ''

      interface HitRow {
        session_id: string
        at: string
        role: string
        snip: string
      }

      const fts = sanitizeFtsQuery(query)
      let rows: HitRow[] = []
      if (fts) {
        try {
          rows = db
            .prepare(
              `SELECT e.session_id, e.at, e.role,
                      snippet(episodes_fts, 0, '', '', '…', 24) AS snip
               FROM episodes_fts f JOIN episodes e ON e.id = f.rowid
               WHERE episodes_fts MATCH ? AND e.slug = ? AND e.at >= ?
               ORDER BY rank LIMIT ?`,
            )
            .all(fts, slug, cutoff, limit) as unknown as HitRow[]
        } catch {
          rows = []
        }
      }
      if (rows.length === 0) {
        // 与 memory-store 同策:trigram 需 ≥3 字符,两字中文词回退 LIKE 截窗。
        const term = query.trim()
        if (term) {
          const likeRows = db
            .prepare(
              `SELECT session_id, at, role, text FROM episodes
               WHERE text LIKE ? AND slug = ? AND at >= ?
               ORDER BY at DESC LIMIT ?`,
            )
            .all(`%${term}%`, slug, cutoff, limit) as unknown as Array<HitRow & { text: string }>
          rows = likeRows.map((r) => {
            const idx = r.text.indexOf(term)
            const start = Math.max(0, idx - LIKE_SNIPPET_BEFORE)
            const end = Math.min(r.text.length, idx + term.length + LIKE_SNIPPET_AFTER)
            const snip =
              (start > 0 ? '…' : '') + r.text.slice(start, end) + (end < r.text.length ? '…' : '')
            return { session_id: r.session_id, at: r.at, role: r.role, snip }
          })
        }
      }
      return rows.map((r) => ({
        sessionId: r.session_id,
        at: r.at,
        role: r.role,
        snippet: r.snip.replace(/\s+/g, ' ').trim(),
      }))
    },

    close() {
      db.close()
    },
  }
}
