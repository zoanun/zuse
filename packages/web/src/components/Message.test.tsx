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
      { kind: 'tool-result', id: 't1', name: 'Bash', output: 'a b c', isError: false },
    ] }} />)
    expect(screen.getByText(/⚙ Bash/)).toBeInTheDocument()
    expect(screen.getByText('a b c')).toBeInTheDocument()
  })

  it('renders a system notice with the kind class', () => {
    const { container } = render(<Message msg={{ id: 'n0', role: 'system', parts: [{ kind: 'text', text: 'boom' }], noticeKind: 'error' }} />)
    const note = container.querySelector('.note.bad')
    expect(note).not.toBeNull()
    expect(note?.textContent).toBe('boom')
  })

  it('suppresses TodoWrite tool calls (shown in the TodosPanel instead)', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'TodoWrite', input: { todos: [] } },
      { kind: 'tool-result', id: 't1', name: 'TodoWrite', output: 'ok', isError: false },
    ] }} />)
    expect(container.querySelector('.tool')).toBeNull()
  })

  it('does not crash when a tool-use has undefined input', () => {
    // JSON.stringify(undefined) === undefined; safeJson must coalesce to a string.
    expect(() => render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Noop', input: undefined },
    ] }} />)).not.toThrow()
    expect(screen.getByText(/⚙ Noop/)).toBeInTheDocument()
    expect(screen.getByText('undefined')).toBeInTheDocument()
  })

  it('renders an orphan tool-result without a matching tool-use', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-result', id: 't9', name: 'tool', output: 'lonely', isError: false },
    ] }} />)
    expect(screen.getByText('lonely')).toBeInTheDocument()
  })

  it('marks an error tool-result with the err class', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Bash', input: {} },
      { kind: 'tool-result', id: 't1', name: 'Bash', output: 'boom', isError: true },
    ] }} />)
    expect(container.querySelector('.result.err')).not.toBeNull()
  })
})
