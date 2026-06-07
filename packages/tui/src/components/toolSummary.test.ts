import { describe, it, expect } from 'vitest'
import {
  stripTrailingNotes,
  countLines,
  previewLines,
  toolSpecifier,
} from './toolSummary.js'

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
