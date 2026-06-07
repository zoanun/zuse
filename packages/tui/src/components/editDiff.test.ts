import { describe, it, expect } from 'vitest'
import { computeLineDiff, diffStats, capDiff } from './editDiff.js'
import type { DiffRow } from './editDiff.js'

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

describe('diffStats', () => {
  it('分别数 add / del,context 不计', () => {
    const rows: DiffRow[] = [
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
      { kind: 'add', text: 'z' },
    ]
    expect(diffStats(rows)).toEqual({ added: 2, removed: 1 })
  })
  it('空 diff 全 0', () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0 })
  })
})

describe('capDiff', () => {
  it('不超上限时原样返回,more=0', () => {
    const rows: DiffRow[] = [
      { kind: 'add', text: '1' },
      { kind: 'add', text: '2' },
    ]
    expect(capDiff(rows, 10)).toEqual({ rows, more: 0 })
  })
  it('超上限时截前 max 行,more 记溢出数', () => {
    const rows: DiffRow[] = Array.from({ length: 12 }, (_, k) => ({
      kind: 'context' as const,
      text: String(k),
    }))
    const out = capDiff(rows, 10)
    expect(out.rows).toHaveLength(10)
    expect(out.more).toBe(2)
    expect(out.rows[9]).toEqual({ kind: 'context', text: '9' })
  })
})
