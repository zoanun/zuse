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
  // node_modules 里也放一个含 pattern 的文件：默认应被忽略目录过滤掉。
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await writeFile(
    join(dir, 'node_modules', 'dep', 'index.ts'),
    'export const runAgent = 1\n',
    'utf8',
  )
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

  it('is case-sensitive by default and case-insensitive with ignore_case', async () => {
    const sensitive = await GrepTool.run({ pattern: 'RUNAGENT' }, makeCtx())
    expect(sensitive.output).toMatch(/no matches/i)
    const insensitive = await GrepTool.run({ pattern: 'RUNAGENT', ignore_case: true }, makeCtx())
    expect(insensitive.output).toContain('a.ts')
  })

  it('matches $-anchored patterns on CRLF files without a trailing carriage return', async () => {
    const result = await GrepTool.run({ pattern: 'true;$', glob: 'src/crlf.ts' }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('crlf.ts')
    // 命中行文本不应夹带 '\r'。
    expect(result.output).not.toContain('\r')
  })

  it('ignores node_modules by default, but searches it when targeted by an explicit glob', async () => {
    const def = await GrepTool.run({ pattern: 'runAgent' }, makeCtx())
    expect(def.output).not.toContain('node_modules')
    // 显式把 glob 指向 node_modules：绕过默认忽略，应能命中。
    const explicit = await GrepTool.run(
      { pattern: 'runAgent', glob: 'node_modules/**/*.ts' },
      makeCtx(),
    )
    expect(explicit.output).toContain('index.ts')
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
    expect(result.output).toMatch(/invalid regular expression/i)
  })

  it('returns is_error when pattern is missing', async () => {
    const result = await GrepTool.run({}, makeCtx())
    expect(result.isError).toBe(true)
  })
})
