import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MessageList } from './MessageList.js'
import type { Message } from '../state/types.js'

const convo: Message[] = [
  { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'a question' }] },
  { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'an answer' }] },
  { id: 'n1', role: 'system', parts: [{ kind: 'text', text: 'notice' }], noticeKind: 'info' },
]

describe('MessageList', () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView; stub it so the auto-scroll effects don't throw.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('scrolls to the bottom when a permission card appears (pendingCount > 0)', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const { rerender } = render(<MessageList messages={[]} thinking={false} pendingCount={0} />)
    spy.mockClear()
    rerender(<MessageList messages={[]} thinking={false} pendingCount={1} />)
    expect(spy).toHaveBeenCalled()
  })
  it('shows the empty state when there are no messages', () => {
    render(<MessageList messages={[]} thinking={false} />)
    expect(screen.getByText('输入任意内容，开始和 zuse 对话')).toBeInTheDocument()
  })

  it('hides the empty state once a message exists', () => {
    render(<MessageList
      messages={[{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]}
      thinking={false}
    />)
    expect(screen.queryByText('输入任意内容，开始和 zuse 对话')).toBeNull()
  })

  it('renders system notice messages with their kind classes (error→bad, warn→warn, info→live)', () => {
    const messages: Message[] = [
      { id: 'n0', role: 'system', parts: [{ kind: 'text', text: 'boom' }], noticeKind: 'error' },
      { id: 'n1', role: 'system', parts: [{ kind: 'text', text: 'careful' }], noticeKind: 'warn' },
      { id: 'n2', role: 'system', parts: [{ kind: 'text', text: 'fyi' }], noticeKind: 'info' },
    ]
    const { container } = render(<MessageList messages={messages} thinking={false} />)
    expect(container.querySelector('.note.bad')?.textContent).toBe('boom')
    expect(container.querySelector('.note.warn')?.textContent).toBe('careful')
    expect(container.querySelector('.note.live')?.textContent).toBe('fyi')
  })

  it('renders a thinking indicator when thinking', () => {
    const { container } = render(<MessageList messages={[]} thinking={true} />)
    expect(container.querySelector('.thinking')).not.toBeNull()
  })

  it('puts the retry control only on the latest assistant reply, and not while thinking', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<MessageList messages={convo} thinking={false} onRetry={onRetry} />)
    const retries = screen.getAllByLabelText('重试')
    expect(retries).toHaveLength(1)
    fireEvent.click(retries[0]!)
    expect(onRetry).toHaveBeenCalled()
    rerender(<MessageList messages={convo} thinking={true} onRetry={onRetry} />)
    expect(screen.queryByLabelText('重试')).toBeNull()
  })

  it('shows the copy/share footer only on a turn\'s final assistant message, not mid-turn ones', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'q' }] },
      // Mid-turn: prose between tool calls, followed by another assistant message → no footer.
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'let me look' }, { kind: 'tool-use', id: 't1', name: 'Bash', input: {} }] },
      // Turn-final: next message is not an assistant → gets the footer.
      { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: 'final answer' }] },
    ]
    const { container } = render(<MessageList messages={messages} thinking={false} onShare={vi.fn()} />)
    expect(container.querySelectorAll('.msg-actions')).toHaveLength(1)
    expect(screen.getAllByLabelText('复制回复')).toHaveLength(1)
    expect(screen.getAllByLabelText('分享')).toHaveLength(1)
  })

  it('a mid-turn steer bubble does not make the assistant before it turn-final (no premature footer)', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'q' }] },
      // Reply's first part, still streaming when the user interjects.
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'working on it' }] },
      // Steer inserted mid-turn — must NOT close the turn, so a1 keeps no footer.
      { id: 'u2', role: 'user', parts: [{ kind: 'text', text: 'also do X' }], steer: true },
      // The turn continues and finishes here → this one gets the footer.
      { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: 'done both' }] },
    ]
    const { container } = render(<MessageList messages={messages} thinking={false} onShare={vi.fn()} />)
    expect(container.querySelectorAll('.msg-actions')).toHaveLength(1)
    // The footer belongs to a2 (the real turn end), not a1.
    expect(within(container.querySelector('#msg-a2') as HTMLElement).getByLabelText('复制回复')).toBeInTheDocument()
    // And the steer bubble carries its "↪ 插话" marker.
    expect(container.querySelector('.steer-tag')?.textContent).toContain('插话')
  })

  it('still footers the final reply when a steer bubble is the LAST message in the stream', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'q' }] },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'the finished answer' }] },
      // A steer landed after the reply finished, with no further assistant message — a1 is still
      // the turn's final reply and MUST keep its copy/share footer (regression guard).
      { id: 'u2', role: 'user', parts: [{ kind: 'text', text: 'one more thing' }], steer: true },
    ]
    const { container } = render(<MessageList messages={messages} thinking={false} onShare={vi.fn()} />)
    expect(within(container.querySelector('#msg-a1') as HTMLElement).getByLabelText('复制回复')).toBeInTheDocument()
  })

  it('in share mode shows a checkbox only for prose messages and toggles selection', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <MessageList messages={convo} thinking={false} shareMode selected={new Set(['u1', 'a1'])} onToggleSelect={onToggle} />,
    )
    const checks = container.querySelectorAll<HTMLInputElement>('.msg-check')
    expect(checks).toHaveLength(2)            // user + assistant; the system notice is hidden
    expect(checks[0]!.checked).toBe(true)
    fireEvent.click(checks[0]!)
    expect(onToggle).toHaveBeenCalledWith('u1')
    expect(screen.queryByLabelText('分享')).toBeNull()
    expect(screen.queryByLabelText('重试')).toBeNull()
  })

  it('share mode hides tool-only assistant turns (nothing to export)', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'do it' }] },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'tool-use', id: 't1', name: 'Bash', input: {} }] }, // no prose
      { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: 'done' }] },
    ]
    const { container } = render(
      <MessageList messages={messages} thinking={false} shareMode selected={new Set()} onToggleSelect={vi.fn()} />,
    )
    expect(container.querySelectorAll('.msg-check')).toHaveLength(2)
  })

  it('flashes and scrolls to the jump target on the FIRST scrollToId, and clears it', () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const onScrolled = vi.fn()
    // Target not set yet → no scroll, nothing cleared.
    const { container, rerender } = render(
      <MessageList messages={convo} thinking={false} scrollToId={null} onScrolled={onScrolled} />,
    )
    scrollSpy.mockClear()
    // First jump to 'a1'.
    rerender(<MessageList messages={convo} thinking={false} scrollToId={'a1'} onScrolled={onScrolled} />)
    const el = container.querySelector('#msg-a1')
    expect(el).not.toBeNull()
    expect(el!.classList.contains('flash')).toBe(true)   // ← the highlight the user should see
    expect(scrollSpy).toHaveBeenCalled()
    expect(onScrolled).toHaveBeenCalledTimes(1)
    // Real app: onScrolled sets pendingScrollTo=null → a re-render with scrollToId=null follows.
    // The imperatively-added 'flash' class must SURVIVE that render (React must not wipe it),
    // or the highlight would vanish before the 1.5s animation is seen.
    rerender(<MessageList messages={convo} thinking={false} scrollToId={null} onScrolled={onScrolled} />)
    expect(container.querySelector('#msg-a1')!.classList.contains('flash')).toBe(true)
  })

  /**
   * 代码预览「运行」按钮的禁用信号，整条接线只有这一条测试盯着：
   * `MessageList`（thinking + 最后一条 assistant → streamingId）→ `Message` 的 streaming prop
   * → `Markdown` 的 `StreamingContext` → `CodeBlock` 的 `disabled`。
   *
   * 为什么必须端到端测这条链，而不是单测 CodeBlock：`CodeBlock` **自己判断不了**围栏是否
   * 闭合 —— 未闭合的 ```jsx 围栏渲染出的 <pre> 结构和闭合的完全一样（设计 §4.1）。
   * 信号只能从上面传下来，链上任何一环断了都是「模型刚吐半个组件，按钮就可点」，
   * 而且**没有任何报错**。链子中间是 context，最容易在重构里被悄悄弄断。
   */
  it('流式未完成时，代码块的「运行」按钮禁用；流式结束后恢复可点', () => {
    const streamingConvo: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '写个组件' }] },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '```jsx\nconst a = 1\n```' }] },
    ]
    const { container, rerender } = render(<MessageList messages={streamingConvo} thinking />)
    const runBtn = () => container.querySelector('.code-run') as HTMLButtonElement | null
    expect(runBtn()).not.toBeNull() // 是禁用不是隐藏：隐藏会让按钮在流结束瞬间跳出来，布局抖动
    expect(runBtn()!.disabled).toBe(true)

    rerender(<MessageList messages={streamingConvo} thinking={false} />)
    expect(runBtn()!.disabled).toBe(false)
  })

  it('只有正在流式的那条消息里的运行按钮被禁用，更早的回复不受牵连', () => {
    const messages: Message[] = [
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '```jsx\nconst old = 1\n```' }] },
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '再写一个' }] },
      { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: '```jsx\nconst neu = 2\n```' }] },
    ]
    const { container } = render(<MessageList messages={messages} thinking />)
    const btns = container.querySelectorAll<HTMLButtonElement>('.code-run')
    expect(btns).toHaveLength(2)
    expect(btns[0]!.disabled).toBe(false) // 上一轮的回复早就写完了
    expect(btns[1]!.disabled).toBe(true)  // 正在吐的这条
  })

  it('selected rows carry the .sel class', () => {
    const { container } = render(
      <MessageList messages={convo} thinking={false} shareMode selected={new Set(['a1'])} onToggleSelect={vi.fn()} />,
    )
    const rows = container.querySelectorAll('.msg-row')
    expect(within(rows[1] as HTMLElement).getByText('an answer')).toBeInTheDocument()
    expect(rows[1]!.className).toContain('sel')
    expect(rows[0]!.className).not.toContain('sel')
  })
})
