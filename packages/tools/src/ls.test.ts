import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LSTool } from './ls.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

let dir: string

function makeCtx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, tracker: createFileTracker() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-ls-'))
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'a.txt'), 'a', 'utf8')
  await writeFile(join(dir, 'b.txt'), 'b', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LSTool', () => {
  it('lists entries with directories suffixed by /', async () => {
    const result = await LSTool.run({ path: dir }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('sub/')
    expect(result.output).toContain('a.txt')
    expect(result.output).toContain('b.txt')
  })

  it('lists directories before files', async () => {
    const result = await LSTool.run({ path: dir }, makeCtx())
    const lines = result.output.split('\n')
    expect(lines[0]).toBe('sub/')
  })

  it('defaults to cwd when path is omitted', async () => {
    const result = await LSTool.run({}, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('a.txt')
  })

  it('returns is_error for a missing path', async () => {
    const result = await LSTool.run({ path: join(dir, 'nope') }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not found/i)
  })

  it('returns is_error when path is a file', async () => {
    const result = await LSTool.run({ path: join(dir, 'a.txt') }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not a directory/i)
  })
})
