import { describe, it, expect } from 'vitest'
import { matchesFilter, filterItems, clampIndex, computeViewport } from './selectListCore.js'
import type { SelectListItem } from './selectListCore.js'

describe('matchesFilter — 子序列模糊匹配', () => {
  it('空 query 命中一切', () => {
    expect(matchesFilter('anything', '')).toBe(true)
  })

  it('连续子串命中', () => {
    expect(matchesFilter('openai/gpt-5', 'gpt')).toBe(true)
  })

  it('非连续子序列也命中（按序出现即可）', () => {
    // m-i-m-o 的字符按序散落在 "mimo-large" 里
    expect(matchesFilter('xmiamo', 'mimo')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(matchesFilter('OpenAI/GPT', 'gpt')).toBe(true)
  })

  it('乱序不命中', () => {
    expect(matchesFilter('abc', 'cab')).toBe(false)
  })

  it('query 比文本长不命中', () => {
    expect(matchesFilter('ab', 'abc')).toBe(false)
  })
})

describe('filterItems — 按 query 过滤并保序', () => {
  const items: SelectListItem[] = [
    { value: '0', label: 'openai/gpt-5' },
    { value: '1', label: 'mimo/mimo-large' },
    { value: '2', label: 'deepseek/deepseek-v4' },
  ]

  it('空 query 原样返回', () => {
    expect(filterItems(items, '').map((i) => i.value)).toEqual(['0', '1', '2'])
  })

  it('"mimo" 直接筛到一条', () => {
    expect(filterItems(items, 'mimo').map((i) => i.value)).toEqual(['1'])
  })

  it('优先用 filterText（缺省回落 label）', () => {
    const withFilterText: SelectListItem[] = [
      { value: 'a', label: '别名甲', filterText: 'alpha' },
      { value: 'b', label: '别名乙', filterText: 'beta' },
    ]
    expect(filterItems(withFilterText, 'alpha').map((i) => i.value)).toEqual(['a'])
    // label 是中文，按 filterText 过滤时 label 不参与匹配
    expect(filterItems(withFilterText, '别名').map((i) => i.value)).toEqual([])
  })

  it('无命中返回空数组', () => {
    expect(filterItems(items, 'zzz')).toEqual([])
  })
})

describe('clampIndex — 把下标夹到合法区间', () => {
  it('区间内原样返回', () => {
    expect(clampIndex(2, 5)).toBe(2)
  })

  it('超过末尾夹到最后一项', () => {
    expect(clampIndex(9, 5)).toBe(4)
  })

  it('负数夹到 0', () => {
    expect(clampIndex(-3, 5)).toBe(0)
  })

  it('空列表返回 0', () => {
    expect(clampIndex(2, 0)).toBe(0)
  })
})

describe('computeViewport — 滚动视口（边贴滚动）', () => {
  it('总数不超视口高度：全显示、无上下指示', () => {
    expect(computeViewport(0, 0, 5, 3)).toEqual({ offset: 0, hasAbove: false, hasBelow: false })
  })

  it('选中项在当前窗口内：offset 不动', () => {
    // 总 10 项、视高 4、当前 offset=2(显示 2..5)、选中 3 → 仍可见,不滚
    expect(computeViewport(2, 3, 4, 10)).toEqual({ offset: 2, hasAbove: true, hasBelow: true })
  })

  it('选中项在窗口上方：上滚到把它顶到首行', () => {
    // offset=5、选中 2 → offset 跟到 2
    expect(computeViewport(5, 2, 4, 10)).toMatchObject({ offset: 2 })
  })

  it('选中项在窗口下方：下滚到把它压到末行', () => {
    // offset=0、视高 4、选中 6 → offset = 6-4+1 = 3
    expect(computeViewport(0, 6, 4, 10)).toMatchObject({ offset: 3 })
  })

  it('滚到顶部：hasAbove=false', () => {
    expect(computeViewport(0, 0, 4, 10)).toEqual({ offset: 0, hasAbove: false, hasBelow: true })
  })

  it('滚到底部：hasBelow=false 且 offset 不越界', () => {
    // 选中最后一项 9 → offset = 9-4+1 = 6, 6+4=10=total
    expect(computeViewport(0, 9, 4, 10)).toEqual({ offset: 6, hasAbove: true, hasBelow: false })
  })

  it('空列表：offset=0、无指示', () => {
    expect(computeViewport(0, 0, 4, 0)).toEqual({ offset: 0, hasAbove: false, hasBelow: false })
  })
})
