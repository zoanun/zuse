import { describe, it, expect } from 'vitest'
import { computeLineDiff } from './editDiff.js'

describe('computeLineDiff', () => {
  it('纯新增:尾部加一行', () => {
    expect(computeLineDiff('a\nb', 'a\nb\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
  })
  it('纯删除:去掉中间一行', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'context', text: 'c' },
    ])
  })
  it('替换:删在增前,上下文不动', () => {
    expect(computeLineDiff('a\nx\nb', 'a\ny\nb')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
      { kind: 'context', text: 'b' },
    ])
  })
  it('尾随换行不产生末尾空行', () => {
    expect(computeLineDiff('a\n', 'a\nb\n')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })
  it('保留中间空行(只去尾随换行造的末尾空串)', () => {
    expect(computeLineDiff('a\n\nb', 'a\n\nb')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: '' },
      { kind: 'context', text: 'b' },
    ])
  })
})
