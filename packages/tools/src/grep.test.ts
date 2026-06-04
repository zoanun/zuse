import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrepTool } from './grep.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

let dir: string

function makeCtx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, tracker: createFileTracker() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-grep-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.ts'), 'export function runAgent() {}\nconst x = 1\n', 'utf8')
  await writeFile(join(dir, 'src', 'b.ts'), 'import { runAgent } from "./a"\n', 'utf8')
  await writeFile(join(dir, 'src', 'c.md'), 'no match here\n', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('GrepTool', () => {
  it('finds matching lines as path:line:text', async () => {
    const result = await GrepTool.run({ pattern: 'runAgent' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/a\.ts:1:.*runAgent/)
    expect(result.output).toMatch(/b\.ts:1:.*runAgent/)
    expect(result.output).not.toContain('c.md')
  })

  it('narrows the scan with a glob', async () => {
    const result = await GrepTool.run({ pattern: 'runAgent', glob: 'src/a.ts' }, makeCtx())
    expect(result.output).toContain('a.ts')
    expect(result.output).not.toContain('b.ts')
  })

  it('returns a no-match message (not an error) when nothing matches', async () => {
    const result = await GrepTool.run({ pattern: 'zzz_nope_zzz' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/no matches/i)
  })

  it('returns is_error for an invalid regular expression', async () => {
    const result = await GrepTool.run({ pattern: '(' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/invalid regular expression/i)
  })

  it('returns is_error when pattern is missing', async () => {
    const result = await GrepTool.run({}, makeCtx())
    expect(result.isError).toBe(true)
  })
})
