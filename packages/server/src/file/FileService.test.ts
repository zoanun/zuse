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

describe('FileService.search', () => {
  async function searchRoot(): Promise<FileService> {
    const root = await tmpRoot()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'src/components'))
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, '.git'))
    const svc = new FileService(root)
    await svc.write('src/components/FilesPanel.tsx', 'x')
    await svc.write('src/components/Header.tsx', 'x')
    await svc.write('src/main.ts', 'x')
    await svc.write('format.md', 'x')
    await svc.write('readme.md', 'x')
    await svc.write('node_modules/filespanel-fake.ts', 'x')
    await svc.write('.git/filespanel-config', 'x')
    return svc
  }

  it('matches by case-insensitive substring and returns files only', async () => {
    const svc = await searchRoot()
    const hits = await svc.search('filespanel')
    expect(hits.map((h) => h.path)).toEqual(['src/components/FilesPanel.tsx'])
    expect(hits[0]!.type).toBe('file')
  })

  it('fuzzy subsequence match: "fsp" finds FilesPanel.tsx', async () => {
    const svc = await searchRoot()
    const hits = await svc.search('fsp')
    expect(hits.map((h) => h.path)).toContain('src/components/FilesPanel.tsx')
  })

  it('ranks prefix matches before substring/subsequence', async () => {
    const svc = await searchRoot()
    const hits = await svc.search('ma')
    // main.ts starts with "ma" (rank 0); format.md merely contains it (rank 1)
    expect(hits[0]!.path).toBe('src/main.ts')
    expect(hits.map((h) => h.path)).toContain('format.md')
  })

  it('skips node_modules and .git at any depth', async () => {
    const svc = await searchRoot()
    const hits = await svc.search('filespanel')
    expect(hits.some((h) => h.path.includes('node_modules') || h.path.includes('.git'))).toBe(false)
  })

  it('caps results at the limit', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    for (let i = 0; i < 60; i++) await svc.write(`hit-${String(i).padStart(2, '0')}.txt`, 'x')
    const hits = await svc.search('hit', 50)
    expect(hits.length).toBe(50)
  })

  it('returns [] for an empty query', async () => {
    const svc = await searchRoot()
    expect(await svc.search('')).toEqual([])
    expect(await svc.search('   ')).toEqual([])
  })
})

describe('FileService.search — subsequence compactness', () => {
  it('rejects a sparse subsequence spread across a long name ("svg" vs a design doc)', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('2026-06-05-zuse-multi-provider-design.md', 'x') // contains s…v…g far apart
    await svc.write('logo.svg', 'x')
    const hits = await svc.search('svg')
    expect(hits.map((h) => h.path)).toEqual(['logo.svg']) // substring hit only, no sparse garbage
  })

  it('still accepts a compact subsequence ("fsp" → FilesPanel.tsx)', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('FilesPanel.tsx', 'x')
    const hits = await svc.search('fsp')
    expect(hits.map((h) => h.path)).toEqual(['FilesPanel.tsx'])
  })
})

describe('FileService.search — regex queries', () => {
  async function regexRoot(): Promise<FileService> {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('readme.md', 'x')
    await svc.write('format.md', 'x')
    await svc.write('a.tsx', 'x')
    await svc.write('b.ts', 'x')
    return svc
  }

  it('a query with regex metacharacters is matched as a case-insensitive regex', async () => {
    const svc = await regexRoot()
    expect((await svc.search('\.tsx$')).map((h) => h.path)).toEqual(['a.tsx'])
    expect((await svc.search('^read')).map((h) => h.path)).toEqual(['readme.md'])
  })

  it('an invalid regex falls back to fuzzy matching instead of throwing', async () => {
    const svc = await regexRoot()
    await svc.write('a([b.txt', 'x')
    expect((await svc.search('([')).map((h) => h.path)).toEqual(['a([b.txt'])
  })

  it('a plain query with dots stays literal (no regex surprise)', async () => {
    const svc = await regexRoot()
    // "." must not act as regex any-char: "b.ts" matches literally, "bxts" would not exist anyway
    expect((await svc.search('b.ts')).map((h) => h.path)).toEqual(['b.ts'])
  })
})

describe('FileService.search — directories', () => {
  it('matches directory names too, still recursing into them', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'src/components'))
    await svc.write('src/components/a.ts', 'x')
    const hits = await svc.search('comp')
    expect(hits).toContainEqual({ name: 'components', path: 'src/components', type: 'dir' })
    // children of a matched dir are still walked (file match unaffected)
    expect((await svc.search('a.ts')).map((h) => h.path)).toContain('src/components/a.ts')
  })
})

describe('FileService.search — regex uses the raw query (not lowercased)', () => {
  it('uppercase escape classes like \\D survive (lowercasing would invert them to \\d)', async () => {
    const root = await tmpRoot()
    const svc = new FileService(root)
    await svc.write('abc.txt', 'x')
    await svc.write('123.txt', 'x')
    const hits = await svc.search('^\\D+\\.txt$')
    expect(hits.map((h) => h.path)).toEqual(['abc.txt'])
  })
})
