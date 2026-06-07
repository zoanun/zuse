import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import type { Token } from 'marked'
import {
  inlineSpans,
  spansToPlainText,
  spansWidth,
  padCounts,
  padSpans,
  wrapSpans,
} from './spans.js'

// 取一段 Markdown 段落的行内 token。
function inlineTokens(md: string): Token[] {
  const tokens = marked.lexer(md)
  const para = tokens.find((t) => t.type === 'paragraph')
  if (!para || para.type !== 'paragraph') throw new Error('未解析出 paragraph')
  return para.tokens ?? []
}

describe('inlineSpans — 行内 token 拍平成样式片段', () => {
  it('纯文本一个片段、无样式', () => {
    expect(inlineSpans(inlineTokens('hello'))).toEqual([{ text: 'hello' }])
  })

  it('加粗片段带 bold', () => {
    expect(inlineSpans(inlineTokens('**hi**'))).toEqual([{ text: 'hi', bold: true }])
  })

  it('行内代码:两侧补空格、灰底白字', () => {
    expect(inlineSpans(inlineTokens('`read.ts`'))).toEqual([
      { text: ' read.ts ', backgroundColor: 'gray', color: 'white' },
    ])
  })

  it('删除线带 strikethrough', () => {
    expect(inlineSpans(inlineTokens('~~x~~'))).toEqual([{ text: 'x', strikethrough: true }])
  })

  it('链接:下划线蓝字 + 暗色 (url)', () => {
    expect(inlineSpans(inlineTokens('[t](http://x.y)'))).toEqual([
      { text: 't', underline: true, color: 'blue' },
      { text: ' (http://x.y)', dimColor: true },
    ])
  })

  it('混合:文本 + 代码 + 文本,顺序与样式各自保留', () => {
    expect(inlineSpans(inlineTokens('see `read.ts` now'))).toEqual([
      { text: 'see ' },
      { text: ' read.ts ', backgroundColor: 'gray', color: 'white' },
      { text: ' now' },
    ])
  })

  it('嵌套:加粗里套代码,继承 bold 且代码仍灰底白字', () => {
    expect(inlineSpans(inlineTokens('**a `b`**'))).toEqual([
      { text: 'a ', bold: true },
      { text: ' b ', bold: true, backgroundColor: 'gray', color: 'white' },
    ])
  })

  it('HTML 实体被解码', () => {
    expect(inlineSpans(inlineTokens('a < b'))).toEqual([{ text: 'a < b' }])
  })

  it('breakAs 控制 <br> 呈现:默认空格', () => {
    expect(inlineSpans(inlineTokens('a\\\nb'))).toEqual([{ text: 'a' }, { text: ' ' }, { text: 'b' }])
  })
})

describe('spansToPlainText / spansWidth', () => {
  it('拼接纯文本', () => {
    expect(spansToPlainText([{ text: 'ab' }, { text: 'cd', bold: true }])).toBe('abcd')
  })
  it('按显示宽度计算(中文算 2)', () => {
    expect(spansWidth([{ text: '中' }, { text: 'x' }])).toBe(3)
  })
})

describe('padCounts — 对齐补白量', () => {
  it('left 全补右侧', () => {
    expect(padCounts(2, 5, 'left')).toEqual({ left: 0, right: 3 })
  })
  it('right 全补左侧', () => {
    expect(padCounts(2, 5, 'right')).toEqual({ left: 3, right: 0 })
  })
  it('center 两侧补、余数偏右', () => {
    expect(padCounts(2, 5, 'center')).toEqual({ left: 1, right: 2 })
  })
  it('已够宽不补', () => {
    expect(padCounts(5, 5, 'left')).toEqual({ left: 0, right: 0 })
    expect(padCounts(6, 5, 'left')).toEqual({ left: 0, right: 0 })
  })
})

describe('padSpans — 按对齐把片段补白到定宽', () => {
  it('left 右侧加无样式空格片段', () => {
    expect(padSpans([{ text: 'ab', bold: true }], 5, 'left')).toEqual([
      { text: 'ab', bold: true },
      { text: '   ' },
    ])
  })
  it('right 左侧加空格', () => {
    expect(padSpans([{ text: 'ab' }], 5, 'right')).toEqual([{ text: '   ' }, { text: 'ab' }])
  })
  it('中文按显示宽度补白', () => {
    expect(padSpans([{ text: '中' }], 5, 'left')).toEqual([{ text: '中' }, { text: '   ' }])
  })
  it('已够宽原样返回', () => {
    expect(padSpans([{ text: 'abcd' }], 2, 'left')).toEqual([{ text: 'abcd' }])
  })
})

describe('wrapSpans — 带样式折行', () => {
  it('折行位置与 wrapCell 一致,样式逐片段保留', () => {
    // 'abcdef' 全是 bold,宽 3 → ['abc','def'],每行仍 bold
    expect(wrapSpans([{ text: 'abcdef', bold: true }], 3)).toEqual([
      [{ text: 'abc', bold: true }],
      [{ text: 'def', bold: true }],
    ])
  })

  it('跨样式边界折行:不同样式落在同一物理行各自成片段', () => {
    // 'ab'(普通) + 'cd'(bold),宽 3 → 行1 'abc'(ab 普通 + c bold),行2 'd' bold
    expect(wrapSpans([{ text: 'ab' }, { text: 'cd', bold: true }], 3)).toEqual([
      [{ text: 'ab' }, { text: 'c', bold: true }],
      [{ text: 'd', bold: true }],
    ])
  })

  it('全角字符不被劈开', () => {
    expect(wrapSpans([{ text: '中文测试' }], 4)).toEqual([
      [{ text: '中文' }],
      [{ text: '测试' }],
    ])
  })

  it('空片段返回单个空行', () => {
    expect(wrapSpans([], 4)).toEqual([[]])
  })
})
