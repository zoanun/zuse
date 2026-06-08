import { describe, it, expect } from 'vitest'
import {
  displayWidth,
  decodeEntities,
  listPrefix,
  wrapCell,
  computeColumnWidths,
} from './layout.js'

describe('displayWidth', () => {
  it('半角字符每个算 1 列', () => {
    expect(displayWidth('abc')).toBe(3)
  })
  it('全角/中文字符每个算 2 列', () => {
    expect(displayWidth('中文')).toBe(4)
  })
  it('混合宽度累加正确', () => {
    expect(displayWidth('a中')).toBe(3)
  })
})

describe('decodeEntities', () => {
  it('还原 marked 转义的 5 个 HTML 实体', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;x&quot; &#39;y&#39;')).toBe(`<a> & "x" 'y'`)
  })
  it('先解码其它实体、最后解码 &amp; 避免二次解码', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })
})

describe('listPrefix', () => {
  it('无序列表用圆点', () => {
    expect(listPrefix(false, 0, 1)).toBe('• ')
  })
  it('有序列表用序号,从 start 起算', () => {
    expect(listPrefix(true, 0, 1)).toBe('1. ')
    expect(listPrefix(true, 2, 1)).toBe('3. ')
    expect(listPrefix(true, 0, 5)).toBe('5. ')
  })
})

describe('wrapCell', () => {
  it('按显示宽度折行', () => {
    expect(wrapCell('abcdef', 3)).toEqual(['abc', 'def'])
  })
  it('全角字符不被从中间劈开', () => {
    expect(wrapCell('中文测试', 4)).toEqual(['中文', '测试'])
  })
  it('混合宽度按累计宽度折行', () => {
    expect(wrapCell('a中b', 3)).toEqual(['a中', 'b'])
  })
  it('空串返回单个空行', () => {
    expect(wrapCell('', 4)).toEqual([''])
  })
})

describe('computeColumnWidths', () => {
  it('总宽够用时取每列最大显示宽度', () => {
    expect(computeColumnWidths([['a', 'bb'], ['ccc', 'd']], 200)).toEqual([3, 2])
  })
  it('含中文列按显示宽度算', () => {
    expect(computeColumnWidths([['中文'], ['x']], 200)).toEqual([4])
  })
  it('超总宽时按自然宽度比例压缩', () => {
    // 单列自然宽 4,overhead=3*1+1=4,maxWidth=5 → 内容预算=1 → [1]
    expect(computeColumnWidths([['aaaa'], ['bb']], 5)).toEqual([1])
  })
})
