import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Message } from './Message.js'

describe('Message', () => {
  it('renders a user bubble as plain text', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hello there' }] }} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  it('renders assistant markdown (heading + bold)', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '## Title\n\nsome **bold** text' }] }} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Title')
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong')
  })

  it('renders a tool call with its result', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 't1', output: 'a b c', isError: false },
    ] }} />)
    expect(screen.getByText(/⚙ Bash/)).toBeInTheDocument()
    expect(screen.getByText('a b c')).toBeInTheDocument()
  })
})
