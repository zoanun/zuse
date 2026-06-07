import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { StreamRenderer } from './StreamRenderer.js'
import type { UIMessage } from '../types.js'

function frame(partial: Partial<UIMessage>): string {
  const message: UIMessage = {
    id: '1',
    role: 'assistant',
    text: '',
    isStreaming: false,
    ...partial,
  }
  const { lastFrame, unmount } = render(createElement(StreamRenderer, { message }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('StreamRenderer 助手双态', () => {
  it('定稿后把 Markdown 渲染成富文本(列表出现圆点)', () => {
    const out = frame({ text: '- item', isStreaming: false })
    expect(out).toContain('•')
  })
  it('流式期间按原始纯文本渲染(保留 "- item",不出圆点)', () => {
    const out = frame({ text: '- item', isStreaming: true })
    expect(out).toContain('- item')
    expect(out).not.toContain('•')
  })
})

describe('StreamRenderer 用户消息', () => {
  it('用 › 标记 + 底色高亮渲染,不再用定宽边框盒子(避免缩放变形)', () => {
    const out = frame({ role: 'user', text: 'hello' })
    expect(out).toContain('› hello')
    // 不应出现圆角边框字符（曾经的 borderStyle="round"）。
    expect(out).not.toContain('╭')
    expect(out).not.toContain('╰')
  })
  it('多行用户消息逐行渲染,续行缩进对齐', () => {
    const out = frame({ role: 'user', text: 'line1\nline2' })
    expect(out).toContain('› line1')
    expect(out).toContain('line2')
  })
})

describe('StreamRenderer 工具输出截断', () => {
  it('输出超行内上限时,展示截断标记与可点击的完整输出文件路径', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n')
    const out = frame({
      role: 'tool',
      tool: {
        name: 'Bash',
        input: { command: 'ls' },
        status: 'done',
        output: lines,
        outputFile: '/tmp/zuse/bash-x.txt',
      },
    })
    expect(out).toContain('… +5 行')
    expect(out).toContain('/tmp/zuse/bash-x.txt')
    // 路径包成 OSC 8 超链接:帧里应含 file:// URI 的 OSC 8 引导序列。
    expect(out).toContain(']8;;file:')
    // 仅展示前 10 行:第 11 行不应出现。
    expect(out).not.toContain('line11')
  })
})
