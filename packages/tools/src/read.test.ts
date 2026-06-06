import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadTool } from './read.js'
import { createFileTracker, fingerprintContent, type ToolContext } from '@zuse/core'

const ctx: ToolContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  tracker: createFileTracker(),
}

let dir: string
let filePath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-read-'))
  filePath = join(dir, 'sample.txt')
  await writeFile(filePath, 'line one\nline two\nline three\n', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ReadTool', () => {
  it('reads a file with cat -n style line numbers', async () => {
    const result = await ReadTool.run({ file_path: filePath }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('1\tline one')
    expect(result.output).toContain('2\tline two')
    expect(result.output).toContain('3\tline three')
  })

  it('honors offset and limit', async () => {
    const result = await ReadTool.run({ file_path: filePath, offset: 2, limit: 1 }, ctx)
    expect(result.output).toContain('2\tline two')
    expect(result.output).not.toContain('1\tline one')
    expect(result.output).not.toContain('3\tline three')
  })

  it('returns is_error for a missing file', async () => {
    const result = await ReadTool.run({ file_path: join(dir, 'nope.txt') }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not found/i)
  })

  it('returns is_error for a directory', async () => {
    const result = await ReadTool.run({ file_path: dir }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/directory/i)
  })

  it('returns is_error when file_path is missing', async () => {
    const result = await ReadTool.run({}, ctx)
    expect(result.isError).toBe(true)
  })

  it('registers the read file in the tracker with its content fingerprint', async () => {
    const tracker = createFileTracker()
    const freshCtx: ToolContext = { cwd: process.cwd(), signal: ctx.signal, tracker }
    const expected = fingerprintContent(await readFile(filePath, 'utf8'))
    await ReadTool.run({ file_path: filePath }, freshCtx)
    expect(tracker.getFingerprint(filePath)).toBe(expected)
  })

  it('line-limit truncation also points to the next offset', async () => {
    // 撞行数窗口（非字符上限）时也应给出续读 offset，与字符上限分支保持一致。
    const long = join(dir, 'long.txt')
    await writeFile(long, Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n') + '\n', 'utf8')
    const result = await ReadTool.run({ file_path: long, limit: 10 }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('10\trow 10')
    expect(result.output).not.toContain('row 11')
    expect(result.output).toMatch(/showing lines 1-10 of 5\d/)
    expect(result.output).toMatch(/pass offset: 11 to continue/)
  })

  it('caps output at the character budget and points to the next offset', async () => {
    // 行数没超 2000，但每行很宽：仅靠行数上限挡不住，应由字符上限在行边界处截断。
    const wide = join(dir, 'wide.txt')
    const line = 'x'.repeat(1000)
    await writeFile(wide, Array.from({ length: 300 }, () => line).join('\n') + '\n', 'utf8')
    const result = await ReadTool.run({ file_path: wide }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.output.length).toBeLessThan(110_000) // ~100k 上限 + 提示
    expect(result.output).toMatch(/token budget/i)
    expect(result.output).toMatch(/pass offset: \d+ to continue/i)
    // 截断发生在整行边界：不应出现被腰斩的行号片段。
    expect(result.output).toContain('1\t')
  })
})

describe('ReadTool metadata', () => {
  it('is read-only and exposes file_path as specifier', () => {
    expect(ReadTool.readOnly).toBe(true)
    expect(ReadTool.specifierFor?.({ file_path: 'a.ts' })).toBe('a.ts')
    expect(ReadTool.specifierFor?.({})).toBeNull()
  })
})
