import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryStore, sanitizeFtsQuery, renderMemoryMarkdown, type MemoryStore } from './memory-store.js'

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
