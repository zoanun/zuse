import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, sep } from 'node:path'
import { GlobTool } from './glob.js'
import { createFileTracker, decide, type ToolContext, type ResolvedSettings } from '@zuse/core'

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
  // 隐藏文件：用来验证不再对 dotfile 全盲（fs.glob 时代的 bug）。
  await writeFile(join(dir, '.env'), '', 'utf8')
  // 受控 mtime 的两个文件：old 早于 new，用来验证按修改时间倒序排序。
  await writeFile(join(dir, 'src', 'old.ts'), '', 'utf8')
  await writeFile(join(dir, 'src', 'new.ts'), '', 'utf8')
  await utimes(join(dir, 'src', 'old.ts'), new Date(1_000_000), new Date(1_000_000))
  await utimes(join(dir, 'src', 'new.ts'), new Date(2_000_000), new Date(2_000_000))
  // node_modules 应被剪枝：里面的 .ts 不应出现在结果里。
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'dep', 'index.ts'), '', 'utf8')
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

  it('finds hidden dotfiles (no longer dotfile-blind)', async () => {
    const result = await GlobTool.run({ pattern: '**/.env*' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('.env')
  })

  it('sorts results by modification time, most recent first', async () => {
    const result = await GlobTool.run({ pattern: '**/*.ts' }, makeCtx())
    expect(result.isError).toBeFalsy()
    // new.ts（mtime 更晚）应排在 old.ts 之前。
    expect(result.output.indexOf('new.ts')).toBeLessThan(result.output.indexOf('old.ts'))
  })

  it('prunes node_modules from traversal', async () => {
    const result = await GlobTool.run({ pattern: '**/*.ts' }, makeCtx())
    expect(result.output).not.toContain('node_modules')
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

  it('returns all matches without a note when under the model-side cap', async () => {
    // 未超 RESULT_LIMIT(200)时整份返回、不附截断注记。
    const many = await mkdtemp(join(tmpdir(), 'zuse-glob-few-'))
    try {
      const count = 150
      await Promise.all(
        Array.from({ length: count }, (_, i) => writeFile(join(many, `f${i}.log`), '', 'utf8')),
      )
      const ctx: ToolContext = { cwd: many, signal: new AbortController().signal, tracker: createFileTracker() }
      const result = await GlobTool.run({ pattern: '**/*.log' }, ctx)
      expect(result.isError).toBeFalsy()
      const lines = result.output.split('\n').filter((l) => l.endsWith('.log'))
      expect(lines.length).toBe(count)
      expect(result.output).not.toMatch(/truncated|capped/)
    } finally {
      await rm(many, { recursive: true, force: true })
    }
  })

  it('caps model-facing output at RESULT_LIMIT and notes the true total', async () => {
    // 回归 + 护栏：超出 200 条时，只回前 200 条（mtime 最新），并附一条写明真实总数的
    // 截断注记 —— 既不把上千条灌进模型上下文，又如实告知「共多少、请缩小范围」。
    const many = await mkdtemp(join(tmpdir(), 'zuse-glob-many-'))
    try {
      const count = 260
      await Promise.all(
        Array.from({ length: count }, (_, i) => writeFile(join(many, `f${i}.log`), '', 'utf8')),
      )
      const ctx: ToolContext = { cwd: many, signal: new AbortController().signal, tracker: createFileTracker() }
      const result = await GlobTool.run({ pattern: '**/*.log' }, ctx)
      expect(result.isError).toBeFalsy()
      const lines = result.output.split('\n').filter((l) => l.endsWith('.log'))
      expect(lines.length).toBe(200)
      // 注记须写出真实总数 260，并提示缩小范围。
      expect(result.output).toMatch(/truncated: showing first 200 of 260 matches/)
    } finally {
      await rm(many, { recursive: true, force: true })
    }
  })
})

describe('GlobTool.specifierFor —— 权限限定符必须是搜索根，不是模式串', () => {
  // 安全回归：决定「能读到哪些文件」的是 `cwd` 字段（run() 里的 base），不是 pattern。
  // 曾经返回 pattern —— 于是 {pattern:'**', cwd:'~/.ssh'} 报给权限层的限定符是 `**`
  // （看着像"就在本项目里搜"），实际枚举家目录私钥目录，deny 规则完全拦不住。
  it('返回 cwd 字段；未指定时是 "."', () => {
    expect(GlobTool.specifierFor?.({ pattern: '**' })).toBe('.')
    expect(GlobTool.specifierFor?.({ pattern: '**', cwd: 'src' })).toBe('src')
    expect(GlobTool.specifierFor?.({ pattern: '**', cwd: '/home/u/.ssh' })).toBe('/home/u/.ssh')
  })

  it('deny 规则现在真的拦得住「换个搜索根」的枚举', () => {
    const settings: ResolvedSettings = {
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: [], deny: ['Glob(~/.ssh/**)'] },
      providers: {},
    }
    const home = homedir().split(sep).join('/')
    const evil = { pattern: '**', cwd: `${home}/.ssh` }
    expect(decide(GlobTool, GlobTool.specifierFor!(evil), settings, [], '/repo').decision).toBe('deny')
    // 项目内正常搜索不受影响
    const ok = { pattern: '**/*.ts', cwd: 'src' }
    expect(decide(GlobTool, GlobTool.specifierFor!(ok), settings, [], '/repo').decision).toBe('allow')
  })

  it('pattern 里的 ../ 逃不出搜索根（所以只校验根就是完备的）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'zuse-glob-esc-'))
    try {
      await mkdir(join(base, 'inside'), { recursive: true })
      await writeFile(join(base, 'secret.txt'), 'x', 'utf8')
      const ctx: ToolContext = {
        cwd: base,
        signal: new AbortController().signal,
        tracker: createFileTracker(),
      }
      const r = await GlobTool.run({ pattern: '../*.txt', cwd: join(base, 'inside') }, ctx)
      expect(r.output).toMatch(/No files match/)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
