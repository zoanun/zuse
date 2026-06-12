import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shapeHeadTail, StreamShaper } from './truncate.js'

describe('shapeHeadTail', () => {
  it('passes short text through untouched', () => {
    const r = shapeHeadTail('hello\nworld', { headChars: 100, tailChars: 100 })
    expect(r.truncated).toBe(false)
    expect(r.body).toBe('hello\nworld')
  })

  it('keeps head and tail on line boundaries with a marker in between', () => {
    // 100 行,每行 "row N"(含换行约 7 字符)。预算头尾各 ~70 字符 ≈ 10 行。
    const lines = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`)
    const text = lines.join('\n')
    const r = shapeHeadTail(text, { headChars: 70, tailChars: 70 })
    expect(r.truncated).toBe(true)
    expect(r.body).toContain('row 1')
    expect(r.body).toContain('row 100')
    expect(r.body).not.toContain('row 50')
    expect(r.body).toMatch(/\[truncated: output was \d+ chars \/ 100 lines; showing first \d+ and last \d+ chars\]/)
    // 行边界收口:head 末尾不应是被腰斩的半行(marker 前是完整的 "row N")。
    const beforeMarker = r.body.slice(0, r.body.indexOf('…[truncated'))
    expect(beforeMarker.trimEnd()).toMatch(/row \d+$/)
  })

  it('falls back to a character cut for a single long line', () => {
    // 整段无换行:不为找行边界牺牲内容,按字符切。
    const text = 'x'.repeat(1000)
    const r = shapeHeadTail(text, { headChars: 100, tailChars: 50 })
    expect(r.truncated).toBe(true)
    expect(r.body.startsWith('x'.repeat(100))).toBe(true)
    expect(r.body.endsWith('x'.repeat(50))).toBe(true)
  })

  it('omits the tail clause when tailChars is 0 (head-only shaping)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n')
    const r = shapeHeadTail(text, { headChars: 70, tailChars: 0 })
    expect(r.truncated).toBe(true)
    expect(r.body).toContain('row 1')
    expect(r.body).not.toContain('row 100')
    expect(r.body).toMatch(/showing first \d+ chars\]/)
    expect(r.body).not.toMatch(/and last/)
  })
})

describe('StreamShaper', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zuse-shaper-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const spill = (): { dir: string; prefix: string } => ({ dir: join(dir, 'out'), prefix: 'bash' })

  it('returns everything untouched when under budget, and leaves no spill file', () => {
    const s = new StreamShaper({ headChars: 100, tailChars: 100, spill: spill() })
    s.append('hello ')
    s.append('world')
    const r = s.finalize()
    expect(r.truncated).toBe(false)
    expect(r.body).toBe('hello world')
    expect(r.spillPath).toBeNull()
  })

  it('keeps head and tail across chunk boundaries and reports the true total', () => {
    const s = new StreamShaper({ headChars: 50, tailChars: 50 })
    // 50 chunk × 100 字符 = 5000 字符,首 chunk 与末 chunk 各有标志。
    s.append('HEAD-MARK-' + 'a'.repeat(90))
    for (let i = 0; i < 48; i++) s.append('b'.repeat(100))
    s.append('c'.repeat(90) + '-TAIL-MARK')
    const r = s.finalize()
    expect(r.truncated).toBe(true)
    expect(r.totalChars).toBe(5000)
    expect(r.body).toContain('HEAD-MARK')
    expect(r.body).toContain('TAIL-MARK')
    expect(r.body).not.toContain('bbbb')
  })

  it('spills the full output to disk and points to it in the marker', () => {
    const s = new StreamShaper({ headChars: 50, tailChars: 50, spill: spill() })
    const chunks = ['first-' + 'a'.repeat(60), 'middle-' + 'b'.repeat(60), 'last-' + 'c'.repeat(60)]
    for (const c of chunks) s.append(c)
    const r = s.finalize()
    expect(r.truncated).toBe(true)
    expect(r.spillPath).not.toBeNull()
    expect(r.body).toContain(r.spillPath!)
    expect(r.body).toContain('use Read or Grep')
    // spill 文件 = 完整输出(含被省略的中段)。
    expect(existsSync(r.spillPath!)).toBe(true)
    expect(readFileSync(r.spillPath!, 'utf8')).toBe(chunks.join(''))
  })

  it('deletes a prematurely opened spill file when output ends under budget', () => {
    // 总量越过 headChars(开了 spill)但没越过 head+tail(最终不截断)→ 文件应删掉。
    const s = new StreamShaper({ headChars: 50, tailChars: 100, spill: spill() })
    s.append('a'.repeat(120))
    const r = s.finalize()
    expect(r.truncated).toBe(false)
    expect(r.body).toBe('a'.repeat(120))
    expect(r.spillPath).toBeNull()
    const outDir = join(dir, 'out')
    expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([])
  })

  it('degrades gracefully when the spill dir cannot be created', () => {
    // 把 spill 目录的父路径占成一个普通文件 → mkdir 必失败 → 截断照常,marker 不带路径。
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'occupied', 'utf8')
    const s = new StreamShaper({
      headChars: 50,
      tailChars: 50,
      spill: { dir: join(blocker, 'sub'), prefix: 'bash' },
    })
    for (let i = 0; i < 10; i++) s.append('z'.repeat(100))
    const r = s.finalize()
    expect(r.truncated).toBe(true)
    expect(r.spillPath).toBeNull()
    expect(r.body).toMatch(/\[truncated:/)
    expect(r.body).not.toContain('Full output:')
  })
})
