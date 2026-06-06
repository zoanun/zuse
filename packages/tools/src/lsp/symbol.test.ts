import { describe, it, expect } from 'vitest'
import { locateSymbol } from './symbol.js'

// 测试用文本固定内容，四行拼成一个字符串
const TEXT = [
  'const foo = 1',          // 第 1 行（1-based）
  'function bar() {',       // 第 2 行
  '  return foobar + foo',  // 第 3 行：foobar(整词) 与 foo
  '}',                      // 第 4 行
].join('\n')

describe('locateSymbol', () => {
  it('finds first occurrence across file when no line given', () => {
    const r = locateSymbol(TEXT, 'foo')!
    expect(r.matchedLine).toBe(1)
    // 'const ' = 6 个字符，所以 foo 从 index 6 开始
    expect(r.position).toEqual({ line: 0, character: 6 })
  })
  it('respects the given 1-based line', () => {
    const r = locateSymbol(TEXT, 'foo', 3)!
    expect(r.matchedLine).toBe(3)
    // 第 3 行 '  return foobar + foo'，词边界 foo 在 '+ ' 之后，index 18
    expect(r.position).toEqual({ line: 2, character: 18 })
  })
  it('uses word boundaries (foo does not match inside foobar)', () => {
    // 第 3 行同时有 foobar 和 foo；查 foo 应跳过 foobar，命中后面的独立 foo
    const r = locateSymbol(TEXT, 'foo', 3)!
    expect(r.position.character).toBe(18)
  })
  it('locates foobar itself', () => {
    const r = locateSymbol(TEXT, 'foobar', 3)!
    // 第 3 行 '  return foobar + foo'，foobar 从 index 9 开始
    expect(r.position).toEqual({ line: 2, character: 9 })
  })
  it('returns null when symbol absent', () => {
    expect(locateSymbol(TEXT, 'nope')).toBeNull()
    expect(locateSymbol(TEXT, 'foo', 2)).toBeNull() // 第 2 行没有 foo
  })
  it('escapes regex metacharacters in symbol', () => {
    expect(() => locateSymbol('a.b.c', 'a.b')).not.toThrow()
    // 'a.b' 作为字面量，词边界下 . 不是 \w，匹配从 index 0 开始
    const r = locateSymbol('xx a.b yy', 'a.b')
    expect(r).not.toBeNull()
  })
})
