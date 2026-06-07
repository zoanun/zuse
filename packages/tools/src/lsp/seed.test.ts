import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findSeedFiles } from './seed.js'

const sig = new AbortController().signal

describe('findSeedFiles', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'zuse-seed-'))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a single file matching the extensions (no manifest → root is the lone project)', async () => {
    const dir = path.join(root, 'flat')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'readme.md'), '#')
    writeFileSync(path.join(dir, 'a.ts'), 'export const x = 1')
    const hits = await findSeedFiles(dir, ['.ts', '.tsx'], sig)
    expect(hits).toEqual([path.join(dir, 'a.ts')])
  })

  it('descends into subdirectories to find a match', async () => {
    const dir = path.join(root, 'nested')
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'deep.ts'), 'export const y = 2')
    const hits = await findSeedFiles(dir, ['.ts'], sig)
    expect(hits).toEqual([path.join(dir, 'src', 'deep.ts')])
  })

  it('seeds one file PER project root (dir containing tsconfig.json) — the monorepo case', async () => {
    const dir = path.join(root, 'mono')
    for (const pkg of ['core', 'tools']) {
      const p = path.join(dir, 'packages', pkg)
      mkdirSync(path.join(p, 'src'), { recursive: true })
      writeFileSync(path.join(p, 'tsconfig.json'), '{}')
      writeFileSync(path.join(p, 'src', `${pkg}.ts`), 'export const v = 1')
    }
    const hits = await findSeedFiles(dir, ['.ts'], sig)
    expect(hits.length).toBe(2)
    expect(hits.sort()).toEqual(
      [
        path.join(dir, 'packages', 'core', 'src', 'core.ts'),
        path.join(dir, 'packages', 'tools', 'src', 'tools.ts'),
      ].sort(),
    )
  })

  it('does not descend into node_modules', async () => {
    const dir = path.join(root, 'pruned')
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'lib.ts'), 'export const z = 3')
    const hits = await findSeedFiles(dir, ['.ts'], sig)
    expect(hits).toEqual([])
  })

  it('returns empty when no file matches the extensions', async () => {
    const dir = path.join(root, 'nomatch')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'notes.txt'), 'hi')
    const hits = await findSeedFiles(dir, ['.ts'], sig)
    expect(hits).toEqual([])
  })

  it('returns empty immediately when the signal is already aborted', async () => {
    const dir = path.join(root, 'aborted')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'a.ts'), 'export const x = 1')
    const ac = new AbortController()
    ac.abort()
    const hits = await findSeedFiles(dir, ['.ts'], ac.signal)
    expect(hits).toEqual([])
  })
})
