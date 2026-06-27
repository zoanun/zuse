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
    expect(screen.getByText('Ask zuse anything to get started.')).toBeInTheDocument()
  })

  it('hides the empty state once a message exists', () => {
    render(<MessageList
      messages={[{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]}
      thinking={false}
    />)
    expect(screen.queryByText('Ask zuse anything to get started.')).toBeNull()
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
    const retries = screen.getAllByLabelText('retry')
    expect(retries).toHaveLength(1)
    fireEvent.click(retries[0]!)
    expect(onRetry).toHaveBeenCalled()
    rerender(<MessageList messages={convo} thinking={true} onRetry={onRetry} />)
    expect(screen.queryByLabelText('retry')).toBeNull()
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
    expect(screen.queryByLabelText('share')).toBeNull()
    expect(screen.queryByLabelText('retry')).toBeNull()
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
