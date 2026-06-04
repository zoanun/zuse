import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteTool } from './write.js'
import { ReadTool } from './read.js'
import { createFileTracker, fingerprintContent, type ToolContext } from '@zuse/core'

let dir: string

function makeCtx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, tracker: createFileTracker() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-write-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WriteTool', () => {
  it('creates a new file with the given content', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'new.txt')
    const result = await WriteTool.run({ file_path: filePath, content: 'hello\nworld' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, 'utf8')).toBe('hello\nworld')
  })

  it('creates parent directories as needed', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'a', 'b', 'deep.txt')
    const result = await WriteTool.run({ file_path: filePath, content: 'x' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, 'utf8')).toBe('x')
  })

  it('overwrites an existing file', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'over.txt')
    await WriteTool.run({ file_path: filePath, content: 'first' }, ctx)
    await WriteTool.run({ file_path: filePath, content: 'second' }, ctx)
    expect(await readFile(filePath, 'utf8')).toBe('second')
  })

  it('registers the written file in the tracker so Edit can follow', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'tracked.txt')
    await WriteTool.run({ file_path: filePath, content: 'data' }, ctx)
    expect(ctx.tracker.getFingerprint(filePath)).toBe(fingerprintContent('data'))
  })

  it('refuses to overwrite an existing file that was not read (read-before-edit)', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'unread.txt')
    // 用 fs 直接造一个已存在文件（不经 Write/Read，tracker 里没有它的记录）。
    await writeFile(filePath, 'pre-existing', 'utf8')
    const result = await WriteTool.run({ file_path: filePath, content: 'clobber' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/has not been read/i)
    // 内容未被覆盖。
    expect(await readFile(filePath, 'utf8')).toBe('pre-existing')
  })

  it('allows overwriting an existing file after it has been read', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'read-then-write.txt')
    await writeFile(filePath, 'original', 'utf8')
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await WriteTool.run({ file_path: filePath, content: 'replaced' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, 'utf8')).toBe('replaced')
  })

  it('refuses to overwrite when the file changed after being read', async () => {
    const ctx = makeCtx()
    const filePath = join(dir, 'changed.txt')
    await writeFile(filePath, 'v1', 'utf8')
    await ReadTool.run({ file_path: filePath }, ctx)
    // 读后被外部改动 —— 指纹不再匹配。
    await writeFile(filePath, 'v2-external', 'utf8')
    const result = await WriteTool.run({ file_path: filePath, content: 'v3' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/modified since/i)
  })

  it('returns is_error when writing over a directory', async () => {
    const ctx = makeCtx()
    const result = await WriteTool.run({ file_path: dir, content: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/directory/i)
  })

  it('returns is_error when file_path is missing', async () => {
    const ctx = makeCtx()
    const result = await WriteTool.run({ content: 'x' }, ctx)
    expect(result.isError).toBe(true)
  })
})
