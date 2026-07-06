import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

  it('大小写折叠改变长度(İ→i̇)时高亮偏移不错位', async () => {
    // 'İ'.toLowerCase() is two code units, so an offset from text.toLowerCase().indexOf would be
    // shifted; matching on the original text keeps the <mark> aligned to the real "app".
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('İapp')])
    const svc = new SearchService({ dir })
    expect((await svc.search('app'))[0]!.hits[0]!.snippet.match).toBe('app')
  })

  it('某条消息缺 content 时不搞崩整会话搜索(仍命中其它消息)', async () => {
    // A content-less message (old schema / partial write) must not throw and drop the whole file.
    writeSession('s1', '2026-06-30T10:00:00Z', [{ role: 'assistant' }, userMsg('findme here')])
    const svc = new SearchService({ dir })
    const r = await svc.search('findme')
    expect(r).toHaveLength(1)
    expect(r[0]!.hits[0]!).toMatchObject({ msgIndex: 1, role: 'user' })
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

  it('每会话封顶 perSessionCap,保留最近的,hitCount 记总数', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => userMsg('match ' + i))
    writeSession('s1', '2026-06-30T10:00:00Z', msgs)
    const svc = new SearchService({ dir })
    const r = await svc.search('match', { perSessionCap: 3 })
    expect(r[0]!.hits).toHaveLength(3)
    expect(r[0]!.hitCount).toBe(8)
    // Keeps the LAST 3 hits (highest msgIndex), dropping the earlier ones.
    expect(r[0]!.hits.map((h) => h.msgIndex)).toEqual([5, 6, 7])
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

  it('mtime 不变则复用缓存:改内容但保持 mtime,二次搜索仍返回旧(缓存)结果', async () => {
    const { utimesSync } = await import('node:fs')
    const path = join(dir, 's1.json')
    const fixed = new Date('2020-01-01T00:00:00.000Z')
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('cacheme original')])
    utimesSync(path, fixed, fixed)
    const svc = new SearchService({ dir })
    expect(await svc.search('cacheme')).toHaveLength(1) // 填充缓存(mtime=fixed)
    // 改内容并加新词,但把 mtime 重设为同一 fixed 值 —— 缓存按 mtime 失效,应继续用旧 docs。
    writeSession('s1', '2026-06-30T10:00:00Z', [userMsg('cacheme changed extraword')])
    utimesSync(path, fixed, fixed)
    expect(await svc.search('extraword')).toHaveLength(0) // 旧 docs 无此词 → 证明没重读文件
    expect(await svc.search('cacheme')).toHaveLength(1)   // 旧内容仍命中
  })
})
