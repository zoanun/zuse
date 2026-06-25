import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageList } from './MessageList.js'
import type { Notice } from '../state/types.js'

describe('MessageList', () => {
  it('shows the empty state when there are no messages or notices', () => {
    render(<MessageList messages={[]} notices={[]} thinking={false} />)
    expect(screen.getByText('Ask zuse anything to get started.')).toBeInTheDocument()
  })

  it('hides the empty state once a message exists', () => {
    render(<MessageList
      messages={[{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]}
      notices={[]}
      thinking={false}
    />)
    expect(screen.queryByText('Ask zuse anything to get started.')).toBeNull()
  })

  it('maps notice kinds to their classes (error→bad, warn→warn, info→live)', () => {
    const notices: Notice[] = [
      { id: 'n0', text: 'boom', kind: 'error' },
      { id: 'n1', text: 'careful', kind: 'warn' },
      { id: 'n2', text: 'fyi', kind: 'info' },
    ]
    const { container } = render(<MessageList messages={[]} notices={notices} thinking={false} />)
    expect(container.querySelector('.note.bad')?.textContent).toBe('boom')
    expect(container.querySelector('.note.warn')?.textContent).toBe('careful')
    expect(container.querySelector('.note.live')?.textContent).toBe('fyi')
  })

  it('renders a thinking indicator when thinking', () => {
    const { container } = render(<MessageList messages={[]} notices={[]} thinking={true} />)
    expect(container.querySelector('.thinking')).not.toBeNull()
  })
})
