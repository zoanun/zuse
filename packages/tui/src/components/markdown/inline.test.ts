import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { renderInline } from './inline.js'

// 用 marked 解析一段 Markdown,取出段落的行内 token,渲染成一帧字符串。
function inlineFrame(md: string): string {
  const tokens = marked.lexer(md)
  const para = tokens.find((t) => t.type === 'paragraph')
  if (!para || para.type !== 'paragraph') throw new Error('未解析出 paragraph')
  const { lastFrame, unmount } = render(createElement(Text, null, renderInline(para.tokens ?? [], 'k')))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('renderInline', () => {
  it('加粗输出 ANSI bold 且保留文字', () => {
    const out = inlineFrame('**bold**')
    expect(out).toContain('bold')
    expect(out).toContain('[1m') // bold
  })
  it('删除线输出 ANSI strikethrough', () => {
    const out = inlineFrame('~~gone~~')
    expect(out).toContain('gone')
    expect(out).toContain('[9m') // strikethrough
  })
  it('行内代码保留文字', () => {
    expect(inlineFrame('`code`')).toContain('code')
  })
  it('链接渲染文字与 (url)', () => {
    const out = inlineFrame('[text](http://x.y)')
    expect(out).toContain('text')
    expect(out).toContain('(http://x.y)')
  })
  it('HTML 实体被解码回原字符', () => {
    expect(inlineFrame('a < b & c')).toContain('a < b & c')
  })
})
