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
