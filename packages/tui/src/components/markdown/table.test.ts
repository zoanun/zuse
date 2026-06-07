import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import type { Tokens } from 'marked'
import { Table } from './table.js'

// 解析一段 GFM 表格,渲染成一帧字符串。
function tableFrame(md: string): string {
  const tokens = marked.lexer(md)
  const table = tokens.find((t) => t.type === 'table')
  if (!table || table.type !== 'table') throw new Error('未解析出 table')
  const { lastFrame, unmount } = render(createElement(Table, { token: table as Tokens.Table }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

const MD = [
  '| 文件名 | 路径 |',
  '| --- | --- |',
  '| `read.ts` | `packages/tools/src/read.ts` |',
  '| README.md | 项目根目录 |',
].join('\n')

describe('Table — 单元格内行内 Markdown', () => {
  it('行内代码渲染出文字本身,而不是字面反引号', () => {
    const out = tableFrame(MD)
    expect(out).toContain('read.ts')
    // 关键回归:反引号不能原样出现在输出里。
    expect(out).not.toContain('`')
  })

  it('行内代码带样式(灰底色 ANSI),不是裸文本', () => {
    const out = tableFrame(MD)
    // codespan 渲染为灰底,会带 ANSI 背景色转义。
    expect(out).toMatch(/\[4\d/) // 背景色 SGR(40-49)
  })

  it('表头加粗', () => {
    const out = tableFrame(MD)
    expect(out).toContain('文件名')
    expect(out).toContain('[1m') // bold
  })

  it('画出 box-drawing 边框', () => {
    const out = tableFrame(MD)
    expect(out).toContain('┌')
    expect(out).toContain('│')
    expect(out).toContain('└')
  })
})
