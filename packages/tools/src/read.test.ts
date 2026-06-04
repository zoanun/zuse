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
})
