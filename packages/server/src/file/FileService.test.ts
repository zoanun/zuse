import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService, PathOutsideRootError } from './FileService.js'

describe('FileService (M7)', () => {
  let root: string, svc: FileService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zuse-files-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(root, 'readme.md'), '# hi\n', 'utf8')
    writeFileSync(join(root, 'zeta.txt'), 'z', 'utf8')
    svc = new FileService(root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists the root with dirs first, then files alphabetically', async () => {
    const { path, entries } = await svc.list('')
    expect(path).toBe('')
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:src', 'file:readme.md', 'file:zeta.txt'])
    expect(entries.find((e) => e.name === 'src')?.path).toBe('src')
  })

  it('lists a subdirectory with posix-relative paths', async () => {
    const { path, entries } = await svc.list('src')
    expect(path).toBe('src')
    expect(entries).toEqual([{ name: 'a.ts', path: 'src/a.ts', type: 'file' }])
  })

  it('rejects path traversal outside the root', async () => {
    await expect(svc.list('..')).rejects.toBeInstanceOf(PathOutsideRootError)
    await expect(svc.read('../secret')).rejects.toBeInstanceOf(PathOutsideRootError)
    await expect(svc.list('src/../..')).rejects.toBeInstanceOf(PathOutsideRootError)
  })

  it('reads a text file', async () => {
    const p = await svc.read('src/a.ts')
    expect(p).toMatchObject({ path: 'src/a.ts', content: 'export const a = 1\n', truncated: false, binary: false })
    expect(p.size).toBeGreaterThan(0)
  })

  it('flags a binary file (NUL byte) without shipping content', async () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
    const p = await svc.read('bin.dat')
    expect(p.binary).toBe(true)
    expect(p.content).toBe('')
  })

  it('truncates a file larger than the preview cap', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(300 * 1024), 'utf8')
    const p = await svc.read('big.txt')
    expect(p.truncated).toBe(true)
    expect(p.content.length).toBe(256 * 1024)
    expect(p.size).toBe(300 * 1024)
  })

  it('throws when asked to read a directory', async () => {
    await expect(svc.read('src')).rejects.toThrow(/directory/)
  })
})
