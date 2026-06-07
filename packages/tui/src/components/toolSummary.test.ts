import { describe, it, expect } from 'vitest'
import {
  stripTrailingNotes,
  countLines,
  previewLines,
  toolSpecifier,
  summarizeOutput,
} from './toolSummary.js'
import type { UIToolCall } from '../types.js'

describe('stripTrailingNotes', () => {
  it('剥掉 Read 的 \\n\\n[truncated: …] 尾注', () => {
    expect(stripTrailingNotes('1\tfoo\n2\tbar\n\n[truncated: showing lines 1-2 of 9]')).toBe(
      '1\tfoo\n2\tbar',
    )
  })
  it('剥掉 Bash 的 \\n[exit code: 1] 尾注', () => {
    expect(stripTrailingNotes('boom\n[exit code: 1]')).toBe('boom')
  })
  it('叠加的截断 + 退出码两条尾注都剥掉', () => {
    expect(stripTrailingNotes('out\n…[truncated: output exceeded 30000 chars]\n[exit code: 2]')).toBe(
      'out',
    )
  })
  it('正文里行内的方括号不被误删', () => {
    expect(stripTrailingNotes('5\tconst x = arr[i]')).toBe('5\tconst x = arr[i]')
  })
  it('无尾注时原样返回', () => {
    expect(stripTrailingNotes('a\nb')).toBe('a\nb')
  })
})

describe('countLines', () => {
  it('空串记 0 行', () => {
    expect(countLines('')).toBe(0)
  })
  it('单行记 1,多行按 \\n 数', () => {
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\nc')).toBe(3)
  })
})

describe('previewLines', () => {
  it('不超上限时全给,moreCount=0', () => {
    expect(previewLines('a\nb\nc', 5)).toEqual({ lines: ['a', 'b', 'c'], moreCount: 0 })
  })
  it('超上限时截前 N 行,余下计入 moreCount', () => {
    expect(previewLines('1\n2\n3\n4\n5\n6\n7', 5)).toEqual({
      lines: ['1', '2', '3', '4', '5'],
      moreCount: 2,
    })
  })
  it('空串给空数组', () => {
    expect(previewLines('', 5)).toEqual({ lines: [], moreCount: 0 })
  })
})

describe('toolSpecifier', () => {
  it('Read/Edit/Write 取 file_path', () => {
    expect(toolSpecifier('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolSpecifier('Edit', { file_path: 'src/b.ts' })).toBe('src/b.ts')
    expect(toolSpecifier('Write', { file_path: 'src/c.ts' })).toBe('src/c.ts')
  })
  it('Glob/Grep 取 pattern', () => {
    expect(toolSpecifier('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(toolSpecifier('Grep', { pattern: 'foo' })).toBe('foo')
  })
  it('Bash 取 command,超长截断到 60 + …', () => {
    expect(toolSpecifier('Bash', { command: 'pnpm test' })).toBe('pnpm test')
    const long = 'echo ' + 'x'.repeat(80)
    expect(toolSpecifier('Bash', { command: long })).toBe(long.slice(0, 60) + '…')
  })
  it('WebFetch 取 url、WebSearch 取 query', () => {
    expect(toolSpecifier('WebFetch', { url: 'http://x.y' })).toBe('http://x.y')
    expect(toolSpecifier('WebSearch', { query: 'ink ui' })).toBe('ink ui')
  })
  it('LSP 取 "operation symbol"', () => {
    expect(toolSpecifier('LSP', { operation: 'definition', symbol: 'foo' })).toBe('definition foo')
  })
  it('未知工具回落到压缩 JSON(≤60)', () => {
    expect(toolSpecifier('Mystery', { a: 1 })).toBe('{"a":1}')
  })
  it('取不到主参数时回落 JSON', () => {
    expect(toolSpecifier('Read', { x: 1 })).toBe('{"x":1}')
  })
  it('input 非对象时返回空串', () => {
    expect(toolSpecifier('Read', null)).toBe('')
    expect(toolSpecifier('Read', 'nope')).toBe('')
  })
})

// 构造一个已完成的工具调用,便于测试 summarizeOutput。
function done(partial: Partial<UIToolCall> & { name: string }): UIToolCall {
  return { status: 'done', input: {}, ...partial }
}

describe('summarizeOutput · 错误分支', () => {
  it('非输出价值类工具出错 → kind:error,取首行', () => {
    const s = summarizeOutput(done({ name: 'Read', isError: true, output: 'File not found: x\n更多' }))
    expect(s).toEqual({ kind: 'error', text: 'File not found: x' })
  })
})

describe('summarizeOutput · Read', () => {
  it('正常计行', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '1\tfoo\n2\tbar' }))).toEqual({
      kind: 'line',
      text: 'Read 2 lines',
    })
  })
  it('单行用单数', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '1\tfoo' }))).toEqual({
      kind: 'line',
      text: 'Read 1 line',
    })
  })
  it('带 truncated 尾注时只数正文行', () => {
    const out = '1\ta\n2\tb\n\n[truncated: showing lines 1-2 of 9; pass offset: 3 to continue]'
    expect(summarizeOutput(done({ name: 'Read', output: out }))).toEqual({
      kind: 'line',
      text: 'Read 2 lines',
    })
  })
  it('空文件哨兵 → (empty file)', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '(file is empty: src/x.ts)' }))).toEqual({
      kind: 'line',
      text: '(empty file)',
    })
  })
})

describe('summarizeOutput · Glob', () => {
  it('命中计文件数', () => {
    expect(summarizeOutput(done({ name: 'Glob', output: 'a.ts\nb.ts\nc.ts' }))).toEqual({
      kind: 'line',
      text: 'Found 3 files',
    })
  })
  it('无匹配哨兵 → No files matched', () => {
    expect(summarizeOutput(done({ name: 'Glob', output: 'No files match: *.zzz' }))).toEqual({
      kind: 'line',
      text: 'No files matched',
    })
  })
})

describe('summarizeOutput · Grep', () => {
  it('files_with_matches(默认)计文件数', () => {
    expect(summarizeOutput(done({ name: 'Grep', output: 'a.ts\nb.ts' }))).toEqual({
      kind: 'line',
      text: 'Found 2 files',
    })
  })
  it('content 模式计命中行数', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'content' }, output: 'a.ts:1:x\na.ts:2:y' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 2 lines' })
  })
  it('count 模式求和匹配数与文件数', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'count' }, output: 'a.ts:3\nb.ts:2' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 5 matches in 2 files' })
  })
  it('count 模式容忍 Windows 盘符路径(按最后一个冒号切)', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'count' }, output: 'C:\\src\\a.ts:4' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 4 matches in 1 file' })
  })
  it('无匹配哨兵 → No matches found', () => {
    expect(summarizeOutput(done({ name: 'Grep', output: 'No matches for: zzz' }))).toEqual({
      kind: 'line',
      text: 'No matches found',
    })
  })
})

describe('summarizeOutput · Edit/Write', () => {
  it('Edit 复用 output 的替换数,改写为 Updated <file>', () => {
    const t = done({
      name: 'Edit',
      input: { file_path: 'src/x.ts' },
      output: 'Edited src/x.ts (2 replacement(s)).',
    })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Updated src/x.ts (2 replacement(s))' })
  })
  it('Write 数 input.content 行数', () => {
    const t = done({ name: 'Write', input: { content: 'a\nb\nc' }, output: 'Wrote 5 bytes to x' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Wrote 3 lines' })
  })
})

describe('summarizeOutput · 通用兜底', () => {
  it('未知工具数行数', () => {
    expect(summarizeOutput(done({ name: 'Mystery', output: 'a\nb\nc\nd' }))).toEqual({
      kind: 'line',
      text: '4 lines of output',
    })
  })
})

describe('summarizeOutput · Bash 类预览', () => {
  it('正文未触行内上限时原样全展示', () => {
    const out = '1\n2\n3\n4\n5\n6\n7'
    expect(summarizeOutput(done({ name: 'Bash', output: out }))).toEqual({
      kind: 'preview',
      lines: ['1', '2', '3', '4', '5', '6', '7'],
      moreCount: 0,
    })
  })
  it('正文超 10 行行内上限时截前 10,余下记 moreCount(完整输出由 hook 落盘)', () => {
    const lines = Array.from({ length: 15 }, (_, i) => String(i + 1))
    const result = summarizeOutput(done({ name: 'Bash', output: lines.join('\n') }))
    expect(result.kind).toBe('preview')
    if (result.kind !== 'preview') throw new Error('expected preview')
    expect(result.lines).toHaveLength(10)
    expect(result.lines[9]).toBe('10')
    expect(result.moreCount).toBe(5)
  })
  it('剥掉 [exit code] 尾注后再切预览', () => {
    const out = 'line1\nline2\n[exit code: 1]'
    expect(summarizeOutput(done({ name: 'Bash', isError: true, output: out }))).toEqual({
      kind: 'preview',
      lines: ['line1', 'line2'],
      moreCount: 0,
    })
  })
  it('(no output) 哨兵 → 单行', () => {
    expect(summarizeOutput(done({ name: 'Bash', output: '(no output)' }))).toEqual({
      kind: 'line',
      text: '(no output)',
    })
  })
  it('WebFetch/WebSearch/LSP 同走预览', () => {
    expect(summarizeOutput(done({ name: 'WebFetch', output: 'x\ny' }))).toEqual({
      kind: 'preview',
      lines: ['x', 'y'],
      moreCount: 0,
    })
  })
  it('出错且无正文(仅退出码)→ error 单行', () => {
    expect(summarizeOutput(done({ name: 'Bash', isError: true, output: '\n[exit code: 1]' }))).toEqual({
      kind: 'error',
      text: '',
    })
  })
})
