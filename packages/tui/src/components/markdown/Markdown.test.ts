import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { Markdown } from './Markdown.js'

function frame(source: string): string {
  const { lastFrame, unmount } = render(createElement(Markdown, { source }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('Markdown', () => {
  it('标题:加粗且保留文字', () => {
    const out = frame('# Title')
    expect(out).toContain('Title')
    expect(out).toContain('[1m')
  })
  it('无序列表:圆点前缀 + 各项文字', () => {
    const out = frame('- one\n- two')
    expect(out).toContain('•')
    expect(out).toContain('one')
    expect(out).toContain('two')
  })
  it('有序列表:序号前缀', () => {
    const out = frame('1. a\n2. b')
    expect(out).toContain('1.')
    expect(out).toContain('2.')
  })
  it('嵌套列表:出现至少两个圆点', () => {
    const out = frame('- a\n  - b')
    expect(out).toContain('a')
    expect(out).toContain('b')
    expect((out.match(/•/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
  it('代码块:保留代码文字', () => {
    expect(frame('```\nhello\n```')).toContain('hello')
  })
  it('引用块:左侧竖线 + 文字', () => {
    const out = frame('> quoted')
    expect(out).toContain('│')
    expect(out).toContain('quoted')
  })
  it('表格:绘制网格且保留表头与单元格', () => {
    const out = frame('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('┌')
    expect(out).toContain('│')
    expect(out).toContain('A')
    expect(out).toContain('1')
  })
  it('表格含中文不报错且保留中文', () => {
    const out = frame('| 名 | x |\n|---|---|\n| 一 | yy |')
    expect(out).toContain('名')
    expect(out).toContain('一')
  })
  it('空 source 渲染为空', () => {
    expect(frame('')).toBe('')
  })
  it('lexer 抛错时回退为纯文本', () => {
    const spy = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(frame('# x')).toContain('# x')
    spy.mockRestore()
  })
})
