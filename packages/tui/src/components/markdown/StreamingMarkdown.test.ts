import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { StreamingMarkdown } from './StreamingMarkdown.js'

function frame(source: string): string {
  const { lastFrame, unmount } = render(createElement(StreamingMarkdown, { source }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('StreamingMarkdown 稳定前缀切分', () => {
  it('空 source 渲染为空', () => {
    expect(frame('')).toBe('')
  })
  it('单个未完成块:整体纯文本,字面 # 保留、无加粗', () => {
    const out = frame('# 还在生成的标题')
    expect(out).toContain('# 还在生成的标题')
    expect(out).not.toContain('[1m')
  })
  it('完整标题 + 未完成段落:前缀富渲染,尾部保留字面 **', () => {
    const out = frame('# 标题\n\n正文 **粗体没写完')
    expect(out).toContain('[1m') // 标题已加粗
    expect(out).not.toContain('# 标题') // 字面 # 消失
    expect(out).toContain('**粗体没写完') // 尾部纯文本
  })
  it('未闭合代码围栏(内含空行)整体保持纯文本,不被空行错切', () => {
    const out = frame('前一段。\n\n```js\nconst a = 1\n\nconst b = 2')
    expect(out).toContain('```js')
    expect(out).toContain('const b = 2')
  })
  it('已完成表格 + 生成中的段落:表格出现列分隔线,尾部纯文本', () => {
    const out = frame('| A | B |\n|---|---|\n| 1 | 2 |\n\n下一段还在生成')
    expect(out).toContain('│')
    expect(out).toContain('下一段还在生成')
  })
  it('以空行收尾:最后一个真实块立即富渲染(列表出圆点)', () => {
    const out = frame('- one\n- two\n\n')
    expect(out).toContain('•')
    expect(out).toContain('one')
  })
  it('生成中的列表(无后续块)整体保持纯文本', () => {
    const out = frame('- one\n- two')
    expect(out).toContain('- one')
    expect(out).not.toContain('•')
  })
  it('lexer 抛错时整体回退纯文本', () => {
    const spy = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(frame('# x\n\ny')).toContain('# x')
    spy.mockRestore()
  })
})
