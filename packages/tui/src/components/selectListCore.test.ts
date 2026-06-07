import { describe, it, expect } from 'vitest'
import {
  matchesFilter,
  filterItems,
  filterGroupedItems,
  firstSelectableIndex,
  nextSelectableIndex,
  clampIndex,
  computeViewport,
} from './selectListCore.js'
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

describe('filterGroupedItems — 分组过滤，空组连组头一并隐藏', () => {
  const grouped: SelectListItem[] = [
    { value: 'h0', label: 'openai', kind: 'header' },
    { value: '0', label: 'gpt-5', filterText: 'openai/gpt-5' },
    { value: '1', label: 'gpt-4o', filterText: 'openai/gpt-4o' },
    { value: 'h2', label: 'deepseek', kind: 'header' },
    { value: '2', label: 'deepseek-v4', filterText: 'deepseek/deepseek-v4' },
  ]

  it('空 query 原样返回(含所有组头)', () => {
    expect(filterGroupedItems(grouped, '').map((i) => i.value)).toEqual(['h0', '0', '1', 'h2', '2'])
  })

  it('命中一组内的项：保留该组头 + 命中项，丢掉无命中的整组', () => {
    // "gpt" 只命中 openai 组，deepseek 组无命中 → 其组头一并隐藏
    expect(filterGroupedItems(grouped, 'gpt').map((i) => i.value)).toEqual(['h0', '0', '1'])
  })

  it('按 provider 名(filterText 前缀)过滤到整组', () => {
    expect(filterGroupedItems(grouped, 'deepseek').map((i) => i.value)).toEqual(['h2', '2'])
  })

  it('无任何命中：返回空(所有组头都隐藏)', () => {
    expect(filterGroupedItems(grouped, 'zzz')).toEqual([])
  })

  it('无 header 的普通列表：退化为 filterItems', () => {
    const flat: SelectListItem[] = [
      { value: '0', label: 'alpha' },
      { value: '1', label: 'beta' },
    ]
    expect(filterGroupedItems(flat, 'a').map((i) => i.value)).toEqual(
      filterItems(flat, 'a').map((i) => i.value),
    )
  })
})

describe('firstSelectableIndex — 跳过前导组头', () => {
  it('组头打头时返回首个可选项下标', () => {
    const items: SelectListItem[] = [
      { value: 'h', label: 'g', kind: 'header' },
      { value: '0', label: 'a' },
    ]
    expect(firstSelectableIndex(items)).toBe(1)
  })

  it('首项即可选时返回 0', () => {
    expect(firstSelectableIndex([{ value: '0', label: 'a' }])).toBe(0)
  })

  it('全是组头 / 空列表返回 0', () => {
    expect(firstSelectableIndex([{ value: 'h', label: 'g', kind: 'header' }])).toBe(0)
    expect(firstSelectableIndex([])).toBe(0)
  })
})

describe('nextSelectableIndex — 导航跳过组头', () => {
  // 0:header 1:opt 2:opt 3:header 4:opt
  const items: SelectListItem[] = [
    { value: 'h0', label: 'A', kind: 'header' },
    { value: '0', label: 'a' },
    { value: '1', label: 'b' },
    { value: 'h3', label: 'B', kind: 'header' },
    { value: '2', label: 'c' },
  ]

  it('向下越过组头：从 2 下移跳过 header(3) 落到 4', () => {
    expect(nextSelectableIndex(items, 2, 1)).toBe(4)
  })

  it('向上越过组头：从 4 上移跳过 header(3) 落到 2', () => {
    expect(nextSelectableIndex(items, 4, -1)).toBe(2)
  })

  it('已在末个可选项继续下移：停在原地', () => {
    expect(nextSelectableIndex(items, 4, 1)).toBe(4)
  })

  it('已在首个可选项继续上移：停在原地(不退回组头)', () => {
    expect(nextSelectableIndex(items, 1, -1)).toBe(1)
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
