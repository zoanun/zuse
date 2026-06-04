import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobTool } from './glob.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

let dir: string

function makeCtx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, tracker: createFileTracker() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zuse-glob-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.ts'), '', 'utf8')
  await writeFile(join(dir, 'src', 'b.ts'), '', 'utf8')
  await writeFile(join(dir, 'src', 'c.js'), '', 'utf8')
  await writeFile(join(dir, 'readme.md'), '', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('GlobTool', () => {
  it('matches files recursively by extension', async () => {
    const result = await GlobTool.run({ pattern: '**/*.ts' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
    expect(result.output).not.toContain('c.js')
    expect(result.output).not.toContain('readme.md')
  })

  it('returns a no-match message (not an error) when nothing matches', async () => {
    const result = await GlobTool.run({ pattern: '**/*.rs' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/no files match/i)
  })

  it('returns is_error when pattern is missing', async () => {
    const result = await GlobTool.run({}, makeCtx())
    expect(result.isError).toBe(true)
  })
})
