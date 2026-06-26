import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Message } from './Message.js'

describe('Message', () => {
  it('renders a user bubble as plain text', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hello there' }] }} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  it('renders a revert button on a user message with a checkpointId and calls onRevert with that id', () => {
    const onRevert = vi.fn()
    render(<Message
      msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'do it' }], checkpointId: 'cpX' }}
      onRevert={onRevert}
    />)
    const btn = screen.getByRole('button', { name: 'Revert to this point' })
    fireEvent.click(btn)
    expect(onRevert).toHaveBeenCalledWith('cpX')
  })

  it('shows no revert button on a user message without a checkpointId', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'no cp' }] }} onRevert={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Revert to this point' })).toBeNull()
  })

  it('never shows a revert button on an assistant message', () => {
    render(<Message
      msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'hi' }], checkpointId: 'cpX' }}
      onRevert={() => {}}
    />)
    expect(screen.queryByRole('button', { name: 'Revert to this point' })).toBeNull()
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

  it('pairs batched tool-uses with their results by id (no duplicate {} cards)', () => {
    // Model batched two calls: all tool_use, then all tool_result (the snapshot/ledger shape).
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Grep', input: { pattern: 'greate' } },
      { kind: 'tool-use', id: 't2', name: 'Glob', input: { pattern: '**/greate' } },
      { kind: 'tool-result', id: 't1', name: '', output: 'No matches for: greate', isError: false },
      { kind: 'tool-result', id: 't2', name: '', output: 'No files match', isError: false },
    ] }} />)
    // exactly two cards, each carrying its own result — not four, no empty-{}-args card
    expect(container.querySelectorAll('.tool')).toHaveLength(2)
    expect(container.querySelector('.args')).toBeNull()
    expect(screen.getByText('No matches for: greate')).toBeInTheDocument()
    expect(screen.getByText('No files match')).toBeInTheDocument()
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
