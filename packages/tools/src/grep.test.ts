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
  // 多行文件：验证上下文行（-A/-B/-C）。needle 在第 3 行，前后各有可识别的标记行。
  await writeFile(
    join(dir, 'src', 'ctx.ts'),
    'line before two\nline before one\nthe needle line\nline after one\nline after two\n',
    'utf8',
  )
  // 多处命中：验证 head_limit / offset 分页（5 行都含 needle）。
  await writeFile(
    join(dir, 'src', 'many.ts'),
    'needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n',
    'utf8',
  )
  // CRLF 行尾文件：用来验证 `$` 锚定不被残留的 '\r' 破坏。
  await writeFile(join(dir, 'src', 'crlf.ts'), 'const done = true;\r\nconst other = 1;\r\n', 'utf8')
  // 二进制文件（含 NUL 字节）：grep 应判定为二进制并跳过，不把内容当文本命中。
  await writeFile(
    join(dir, 'src', 'bin.dat'),
    Buffer.from([
      0x72, 0x75, 0x6e, 0x41, 0x67, 0x65, 0x6e, 0x74, 0x00, 0x72, 0x75, 0x6e, 0x41, 0x67, 0x65,
      0x6e, 0x74,
    ]),
  )
  // node_modules 里也放一个含 pattern 的文件：默认应被 .gitignore 过滤掉。
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await writeFile(
    join(dir, 'node_modules', 'dep', 'index.ts'),
    'export const runAgent = 1\n',
    'utf8',
  )
  // ripgrep 仅在搜索目录处于 git 仓库内（存在 .git）时才读 .gitignore，故造一个空 .git。
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('GrepTool — output modes', () => {
  it('defaults to files_with_matches: lists paths, no line numbers or text', async () => {
    const result = await GrepTool.run({ pattern: 'runAgent' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
    // 仅路径：不应出现命中行文本或 "path:line:" 形式。
    expect(result.output).not.toContain('export function runAgent')
    expect(result.output).not.toMatch(/a\.ts:\d+:/)
  })

  it('content mode finds matching lines as path:line:text', async () => {
    const result = await GrepTool.run({ pattern: 'runAgent', output_mode: 'content' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/a\.ts:1:.*runAgent/)
    expect(result.output).toMatch(/b\.ts:1:.*runAgent/)
    expect(result.output).not.toContain('c.md')
  })

  it('count mode shows per-file match counts as path:count', async () => {
    const result = await GrepTool.run({ pattern: 'needle', output_mode: 'count' }, makeCtx())
    expect(result.isError).toBeFalsy()
    // many.ts 有 5 处，ctx.ts 有 1 处。
    expect(result.output).toMatch(/many\.ts:5/)
    expect(result.output).toMatch(/ctx\.ts:1/)
  })
})

describe('GrepTool — content context lines', () => {
  it('includes lines before and after with context', async () => {
    const result = await GrepTool.run(
      { pattern: 'the needle line', output_mode: 'content', context: 1 },
      makeCtx(),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('the needle line')
    expect(result.output).toContain('line before one')
    expect(result.output).toContain('line after one')
    // context:1 不应带到再外一层。
    expect(result.output).not.toContain('line before two')
    expect(result.output).not.toContain('line after two')
  })

  it('before_context / after_context are asymmetric', async () => {
    const result = await GrepTool.run(
      { pattern: 'the needle line', output_mode: 'content', before_context: 2, after_context: 0 },
      makeCtx(),
    )
    expect(result.output).toContain('line before two')
    expect(result.output).toContain('line before one')
    expect(result.output).not.toContain('line after one')
  })
})

describe('GrepTool — head_limit / offset paging', () => {
  it('caps content output to head_limit and notes truncation', async () => {
    const result = await GrepTool.run(
      { pattern: 'needle', output_mode: 'content', glob: 'src/many.ts', head_limit: 2 },
      makeCtx(),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('needle 1')
    expect(result.output).toContain('needle 2')
    expect(result.output).not.toContain('needle 3')
    expect(result.output).toMatch(/truncated/i)
  })

  it('offset skips the first N entries', async () => {
    const result = await GrepTool.run(
      {
        pattern: 'needle',
        output_mode: 'content',
        glob: 'src/many.ts',
        head_limit: 2,
        offset: 2,
      },
      makeCtx(),
    )
    expect(result.output).not.toContain('needle 1')
    expect(result.output).not.toContain('needle 2')
    expect(result.output).toContain('needle 3')
    expect(result.output).toContain('needle 4')
  })
})

describe('GrepTool — filters and robustness', () => {
  it('narrows the scan with a glob', async () => {
    const result = await GrepTool.run({ pattern: 'runAgent', glob: 'src/a.ts' }, makeCtx())
    expect(result.output).toContain('a.ts')
    expect(result.output).not.toContain('b.ts')
  })

  it('narrows the scan with a type filter', async () => {
    // c.md 含 "match" 但限定 type=ts 后不应出现；ts 文件中的 needle 应出现。
    const result = await GrepTool.run({ pattern: 'needle', type: 'ts' }, makeCtx())
    expect(result.output).toContain('many.ts')
    expect(result.output).not.toContain('c.md')
  })

  it('returns a no-match message (not an error) when nothing matches', async () => {
    const result = await GrepTool.run({ pattern: 'zzz_nope_zzz' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/no matches/i)
  })

  it('is case-sensitive by default and case-insensitive with ignore_case', async () => {
    const sensitive = await GrepTool.run({ pattern: 'RUNAGENT' }, makeCtx())
    expect(sensitive.output).toMatch(/no matches/i)
    const insensitive = await GrepTool.run({ pattern: 'RUNAGENT', ignore_case: true }, makeCtx())
    expect(insensitive.output).toContain('a.ts')
  })

  it('matches $-anchored patterns on CRLF files without a trailing carriage return', async () => {
    const result = await GrepTool.run(
      { pattern: 'true;$', output_mode: 'content', glob: 'src/crlf.ts' },
      makeCtx(),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('crlf.ts')
    // 命中行文本不应夹带 '\r'。
    expect(result.output).not.toContain('\r')
  })

  it('respects .gitignore (node_modules is excluded, even when targeted by a glob)', async () => {
    const def = await GrepTool.run({ pattern: 'runAgent' }, makeCtx())
    expect(def.output).not.toContain('node_modules')
    // ripgrep 与 CC 一致：忽略规则优先于 -g include glob，显式 glob 也无法绕过 .gitignore。
    const explicit = await GrepTool.run(
      { pattern: 'runAgent', glob: 'node_modules/**/*.ts' },
      makeCtx(),
    )
    expect(explicit.output).not.toContain('index.ts')
  })

  it('skips binary files (NUL byte) instead of matching their bytes as text', async () => {
    // bin.dat 里有 "runAgent" 的字节，但夹着 NUL —— 应被判为二进制跳过。
    const result = await GrepTool.run({ pattern: 'runAgent', glob: 'src/bin.dat' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/no matches/i)
    expect(result.output).not.toContain('bin.dat')
  })

  it('returns is_error for an invalid regular expression', async () => {
    const result = await GrepTool.run({ pattern: '(' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/regex/i)
  })

  it('returns is_error when pattern is missing', async () => {
    const result = await GrepTool.run({}, makeCtx())
    expect(result.isError).toBe(true)
  })
})
