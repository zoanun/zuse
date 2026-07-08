import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService, PathOutsideRootError, FileChangedError } from './FileService.js'

async function tmpRoot(): Promise<string> { return mkdtemp(join(tmpdir(), 'i3-')) }

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

describe('FileService.write', () => {
  it('writes new content and returns size + mtimeMs', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    const r = await svc.write('note.txt', 'hello')
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('hello')
    expect(r.path).toBe('note.txt')
    expect(r.size).toBe(5)
    expect(typeof r.mtimeMs).toBe('number')
  })

  it('creates a file at a non-existent path (parent exists)', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'sub'))
    const svc = new FileService(root)
    await svc.write('sub/new.md', '# x')
    expect(await readFile(join(root, 'sub/new.md'), 'utf8')).toBe('# x')
  })

  it('rejects a path escaping the root', async () => {
    const svc = new FileService(await tmpRoot())
    await expect(svc.write('../evil.txt', 'x')).rejects.toBeInstanceOf(PathOutsideRootError)
  })

  it('throws FileChangedError when expectMtimeMs does not match', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('a.txt', 'one')
    await expect(svc.write('a.txt', 'two', { expectMtimeMs: 1 })).rejects.toBeInstanceOf(FileChangedError)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one') // unchanged
  })

  it('overwrites despite mismatch when force is set', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('a.txt', 'one')
    await svc.write('a.txt', 'two', { expectMtimeMs: 1, force: true })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two')
  })

  it('write with matching expectMtimeMs succeeds', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('a.txt', 'one')
    const cur = (await stat(join(root, 'a.txt'))).mtimeMs
    await svc.write('a.txt', 'two', { expectMtimeMs: cur })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two')
  })
})

describe('FileService.remove', () => {
  it('deletes a file', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('gone.txt', 'x')
    await svc.remove('gone.txt')
    await expect(stat(join(root, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to delete a directory', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'dir'))
    const svc = new FileService(root)
    await expect(svc.remove('dir')).rejects.toThrow('directory')
  })

  it('rejects a path escaping the root', async () => {
    const svc = new FileService(await tmpRoot())
    await expect(svc.remove('../x')).rejects.toBeInstanceOf(PathOutsideRootError)
  })
})

describe('FileService.statFile', () => {
  it('returns mime by extension', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('pic.png', 'x'); await svc.write('doc.pdf', 'x'); await svc.write('blob.bin', 'x')
    expect((await svc.statFile('pic.png')).mime).toBe('image/png')
    expect((await svc.statFile('doc.pdf')).mime).toBe('application/pdf')
    expect((await svc.statFile('blob.bin')).mime).toBe('application/octet-stream')
  })
  it('rejects a directory and an escaping path', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'd'))
    const svc = new FileService(root)
    await expect(svc.statFile('d')).rejects.toThrow('directory')
    await expect(svc.statFile('../x')).rejects.toBeInstanceOf(PathOutsideRootError)
  })
})
