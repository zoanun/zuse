import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageList } from './MessageList.js'
import type { Message } from '../state/types.js'

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
})
