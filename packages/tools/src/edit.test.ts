import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, readFile, mkdtemp, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditTool } from './edit.js'
import { ReadTool } from './read.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

let dir: string
let filePath: string
let ctx: ToolContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-edit-'))
  filePath = join(dir, 'code.ts')
  await writeFile(filePath, 'const foo = 1\nconst bar = foo + foo\n', 'utf8')
  // 每个用例共用一个 ctx（同一个 tracker），模拟"先 Read 后 Edit"的真实流程。
  ctx = { cwd: dir, signal: new AbortController().signal, tracker: createFileTracker() }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('EditTool', () => {
  it('replaces a unique occurrence after the file is read', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'const foo = 1', new_string: 'const foo = 2' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, 'utf8')).toContain('const foo = 2')
  })

  it('refuses to edit a file that has not been read (read-before-edit)', async () => {
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'const foo = 1', new_string: 'const foo = 2' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/has not been read/i)
  })

  it('refuses to edit when the file changed after being read (mtime lock)', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    // 把 mtime 推到一个明显不同的时刻，模拟读后被外部改动。
    const future = new Date(Date.now() + 10_000)
    await utimes(filePath, future, future)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'const foo = 1', new_string: 'const foo = 2' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/modified since/i)
  })

  it('refuses when old_string is not unique and replace_all is not set', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not unique/i)
  })

  it('replaces every occurrence with replace_all', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const out = await readFile(filePath, 'utf8')
    expect(out).not.toContain('foo')
    expect(out).toContain('const baz = 1')
    expect(out).toContain('const bar = baz + baz')
  })

  it('returns is_error when old_string is not found', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'nonexistent', new_string: 'x' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not found/i)
  })

  it('returns is_error when old_string equals new_string', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    const result = await EditTool.run(
      { file_path: filePath, old_string: 'foo', new_string: 'foo' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/identical/i)
  })

  it('refreshes the tracker so a second edit in the same session works', async () => {
    await ReadTool.run({ file_path: filePath }, ctx)
    await EditTool.run(
      { file_path: filePath, old_string: 'const foo = 1', new_string: 'const foo = 2' },
      ctx,
    )
    // 不再 Read，直接第二次 Edit —— 应当通过（写后已刷新 mtime）。
    const second = await EditTool.run(
      { file_path: filePath, old_string: 'const foo = 2', new_string: 'const foo = 3' },
      ctx,
    )
    expect(second.isError).toBeFalsy()
    const { mtimeMs } = await stat(filePath)
    expect(ctx.tracker.getReadTime(filePath)).toBe(mtimeMs)
  })
})
