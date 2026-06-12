import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openMemoryStore,
  sanitizeFtsQuery,
  renderMemoryMarkdown,
  memoryAgeNote,
  type MemoryStore,
  type MemoryRow,
} from './memory-store.js'

let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-mem-'))
  store = openMemoryStore(join(dir, 'memory.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryStore', () => {
  it('save 返回带 id 的完整行;list 按项目过滤且含全局', () => {
    const a = store.save('user', '用户偏好 pnpm,不用 npm', '') // 全局
    const b = store.save('project', 'zuse 是 pnpm workspace', 'E--ai-study-zuse')
    store.save('project', '别的项目的事实', 'E--other')

    expect(a.id).toBeGreaterThan(0)
    expect(a.type).toBe('user')
    expect(b.project).toBe('E--ai-study-zuse')

    const rows = store.list('E--ai-study-zuse')
    expect(rows.map((r) => r.content)).toEqual(
      expect.arrayContaining(['用户偏好 pnpm,不用 npm', 'zuse 是 pnpm workspace']),
    )
    expect(rows.some((r) => r.content === '别的项目的事实')).toBe(false)
  })

  it('search 用 FTS 命中中文与英文,范围 = 当前项目 ∪ 全局', () => {
    store.save('user', '用户习惯用中文交流', '')
    store.save('project', 'compaction 阈值是 80%', 'E--ai-study-zuse')
    store.save('project', '其他项目里也有 compaction', 'E--other')

    const zh = store.search('中文', 'E--ai-study-zuse')
    expect(zh).toHaveLength(1)
    expect(zh[0]!.content).toContain('中文交流')

    const en = store.search('compaction', 'E--ai-study-zuse')
    expect(en).toHaveLength(1) // 其他项目的不进来
    expect(en[0]!.content).toContain('80%')
  })

  it('search 对两字中文词也能命中(trigram 短查询回退 LIKE)', () => {
    store.save('insight', '压缩切点不能劈开工具配对', 'p')
    const hits = store.search('压缩', 'p')
    expect(hits).toHaveLength(1)
  })

  it('search 带 FTS 语法字符不抛错(词项清洗)', () => {
    store.save('reference', 'vitest docs https://vitest.dev', 'p')
    expect(() => store.search('AND OR NOT "x* -y', 'p')).not.toThrow()
    expect(store.search('vitest "docs"', 'p')).toHaveLength(1)
  })

  it('remove 删除并返回 true;未命中返回 false', () => {
    const row = store.save('user', '要删的', '')
    expect(store.remove(row.id)).toBe(true)
    expect(store.remove(row.id)).toBe(false)
    expect(store.search('要删的', '')).toHaveLength(0) // FTS 同步删除
  })

  it('all 返回全量(投影用),按 id 升序', () => {
    store.save('user', 'a', '')
    store.save('project', 'b', 'p')
    const rows = store.all()
    expect(rows.map((r) => r.content)).toEqual(['a', 'b'])
  })

  it('重开同一 db 文件,数据仍在(schema 幂等)', () => {
    store.save('user', '持久化验证', '')
    store.close()
    store = openMemoryStore(join(dir, 'memory.db'))
    expect(store.all()).toHaveLength(1)
  })
})

describe('sanitizeFtsQuery', () => {
  it('每个词项双引号包裹、OR 连接,内部引号剥除', () => {
    expect(sanitizeFtsQuery('foo bar')).toBe('"foo" OR "bar"')
    expect(sanitizeFtsQuery('a"b')).toBe('"ab"')
  })
  it('空串/纯空白返回空串', () => {
    expect(sanitizeFtsQuery('  ')).toBe('')
  })
})

describe('hook(索引行钩子)', () => {
  it('save 带 hook 往返保留;投影行用 hook 而非正文前缀', () => {
    store.save(
      'insight',
      '排查了两小时:vite 5.4 判定内置模块时会剥掉 node: 前缀查裸名清单,node:sqlite 这类仅限前缀的模块因此被当成 npm 包,解法是 process.getBuiltinModule。',
      'p',
      'vite5 不认 node:sqlite,用 process.getBuiltinModule 绕过',
    )
    const rows = store.all()
    expect(rows[0]!.hook).toContain('getBuiltinModule')
    const md = renderMemoryMarkdown(rows)
    const line = md.split('\n').find((l) => l.startsWith('- [1]'))!
    expect(line).toContain('vite5 不认 node:sqlite')
    expect(line).not.toContain('排查了两小时') // 用钩子,不用正文前缀
  })

  it('无 hook 的记忆投影回退正文前缀截断(兼容旧数据)', () => {
    store.save('user', 'x'.repeat(300), '')
    const md = renderMemoryMarkdown(store.all())
    const line = md.split('\n').find((l) => l.startsWith('- [1]'))!
    expect(line).toContain('…')
  })

  it('老 schema(无 hook 列)的库重开时自动迁移,数据保留', () => {
    store.close()
    const oldDb = join(dir, 'old.db')
    // 手工建一张 Phase 13 初版的表(无 hook 列)并塞一行。
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const raw = new DatabaseSync(oldDb)
    raw.exec(`CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('user','project','insight','reference')),
      content TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    raw.prepare("INSERT INTO memories (type, content, project, created_at, updated_at) VALUES ('user', '老数据', '', 't', 't')").run()
    raw.close()

    store = openMemoryStore(oldDb)
    const rows = store.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('老数据')
    expect(rows[0]!.hook).toBe('') // 迁移补空 hook
    store.save('user', '新数据', '', '新钩子') // 迁移后可正常写入 hook
    expect(store.all()[1]!.hook).toBe('新钩子')
  })
})

describe('memoryAgeNote(年龄标注)', () => {
  const NOW = Date.parse('2026-06-12T12:00:00Z')

  it('≥1 天才标注,当天不标', () => {
    expect(memoryAgeNote('2026-06-12T08:00:00Z', NOW)).toBe('')
    expect(memoryAgeNote('2026-06-10T12:00:00Z', NOW)).toBe('2 天前')
    expect(memoryAgeNote('2026-04-26T12:00:00Z', NOW)).toBe('47 天前')
  })

  it('非法时间串返回空,不抛', () => {
    expect(memoryAgeNote('not-a-date', NOW)).toBe('')
  })

  it('投影行带年龄后缀', () => {
    const row: MemoryRow = {
      id: 1,
      type: 'project',
      content: '旧约定',
      project: 'p',
      hook: '',
      createdAt: '2026-05-12T12:00:00Z',
      updatedAt: '2026-05-12T12:00:00Z',
    }
    const md = renderMemoryMarkdown([row], NOW)
    expect(md).toContain('- [1] 旧约定 (p) · 31 天前')
  })
})

describe('renderMemoryMarkdown(MEMORY.md 投影)', () => {
  it('按类型分组、每条一行带 id,文件头注明自动生成', () => {
    store.save('user', '用户偏好中文', '')
    store.save('project', 'zuse 用 pnpm workspace', 'E--ai-study-zuse')
    const md = renderMemoryMarkdown(store.all())
    expect(md).toContain('自动生成')
    expect(md).toMatch(/## user[\s\S]*- \[1\] 用户偏好中文/)
    expect(md).toMatch(/## project[\s\S]*- \[2\] zuse 用 pnpm workspace/)
    expect(md).toContain('(E--ai-study-zuse)') // 项目记忆标注归属
  })

  it('超长内容截 120 字符', () => {
    store.save('user', 'x'.repeat(300), '')
    const md = renderMemoryMarkdown(store.all())
    const line = md.split('\n').find((l) => l.startsWith('- [1]'))!
    expect(line.length).toBeLessThanOrEqual(140)
    expect(line).toContain('…')
  })

  it('空记忆给出占位说明', () => {
    expect(renderMemoryMarkdown([])).toContain('还没有任何记忆')
  })
})
