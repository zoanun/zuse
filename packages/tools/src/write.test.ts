import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteTool } from './write.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

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
    const { mtimeMs } = await stat(filePath)
    expect(ctx.tracker.getReadTime(filePath)).toBe(mtimeMs)
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
