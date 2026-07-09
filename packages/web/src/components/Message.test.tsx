import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Message, splitThink, replyMarkdown } from './Message.js'

// Tool cards are collapsed by default — open every one so result/body assertions can see them.
const expandTools = (container: HTMLElement): void => {
  container.querySelectorAll('button.head').forEach((b) => fireEvent.click(b))
}

describe('Message', () => {
  it('renders a user bubble as plain text', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hello there' }] }} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  it('renders an attachment thumbnail (img with the upload URL) and a direct-route badge', () => {
    render(<Message msg={{
      id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'look' }],
      attachments: [{ id: 'x', name: 'a.png', mediaType: 'image/png', route: 'direct' }],
    }} />)
    const img = screen.getByRole('img', { name: 'a.png' })
    expect(img.getAttribute('src')).toContain('/api/uploads/x')
    expect(screen.getByText('图·直传')).toBeInTheDocument()
  })

  it('shows a parsed-route badge and the (expandable) description text for a parsed attachment', () => {
    render(<Message msg={{
      id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'look' }],
      attachments: [{ id: 'y', name: 'cat.png', mediaType: 'image/png', route: 'parsed', description: '一只猫' }],
    }} />)
    expect(screen.getByText('图·解析')).toBeInTheDocument()
    expect(screen.getByText('查看解析')).toBeInTheDocument()
    expect(screen.getByText('一只猫')).toBeInTheDocument()
  })

  it('shows no route badge for an attachment still awaiting its snapshot (route undefined)', () => {
    render(<Message msg={{
      id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'look' }],
      attachments: [{ id: 'z', name: 'p.png', mediaType: 'image/png' }],
    }} />)
    expect(screen.getByRole('img', { name: 'p.png' })).toBeInTheDocument()
    expect(screen.queryByText('图·直传')).toBeNull()
    expect(screen.queryByText('图·解析')).toBeNull()
  })

  it('renders no thumbnails on a user message without attachments', () => {
    const { container } = render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }} />)
    expect(container.querySelector('.msg-imgs')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders thumbnails for an image-only message (empty text)', () => {
    render(<Message msg={{
      id: 'u1', role: 'user', parts: [],
      attachments: [{ id: 'x', name: 'a.png', mediaType: 'image/png', route: 'direct' }],
    }} />)
    expect(screen.getByRole('img', { name: 'a.png' })).toBeInTheDocument()
  })

  it('renders a revert button on a user message with a checkpointId and calls onRevert with that id', () => {
    const onRevert = vi.fn()
    render(<Message
      msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'do it' }], checkpointId: 'cpX' }}
      onRevert={onRevert}
    />)
    fireEvent.click(screen.getByRole('button', { name: '回退到此处' }))
    expect(onRevert).toHaveBeenCalledWith('cpX')
  })

  it('shows no revert button on a user message without a checkpointId', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'no cp' }] }} onRevert={() => {}} />)
    expect(screen.queryByRole('button', { name: '回退到此处' })).toBeNull()
  })

  it('never shows a revert button on an assistant message', () => {
    render(<Message
      msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'hi' }], checkpointId: 'cpX' }}
      onRevert={() => {}}
    />)
    expect(screen.queryByRole('button', { name: '回退到此处' })).toBeNull()
  })

  it('renders assistant markdown (heading + bold)', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '## Title\n\nsome **bold** text' }] }} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Title')
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong')
  })

  it('renders a tool call with its result (once expanded)', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 't1', name: 'Bash', output: 'a b c', isError: false },
    ] }} />)
    expect(screen.getByText(/⚙ Bash/)).toBeInTheDocument()
    expandTools(container)
    expect(screen.getByText('a b c')).toBeInTheDocument()
  })

  it('pairs batched tool-uses with their results by id (no duplicate {} cards)', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Grep', input: { pattern: 'greate' } },
      { kind: 'tool-use', id: 't2', name: 'Glob', input: { pattern: '**/greate' } },
      { kind: 'tool-result', id: 't1', name: '', output: 'No matches for: greate', isError: false },
      { kind: 'tool-result', id: 't2', name: '', output: 'No files match', isError: false },
    ] }} />)
    expect(container.querySelectorAll('.tool')).toHaveLength(2)
    expandTools(container)
    expect(container.querySelector('.args')).toBeNull()
    expect(screen.getByText('No matches for: greate')).toBeInTheDocument()
    expect(screen.getByText('No files match')).toBeInTheDocument()
  })

  it('folds a <think> block into a collapsed details, answer stays visible', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'text', text: '<think>let me reason about this</think>The answer is **42**.' },
    ] }} />)
    const details = container.querySelector('details.think')
    expect(details).not.toBeNull()
    expect(details!.hasAttribute('open')).toBe(false)
    expect(container.querySelector('.think-body')?.textContent).toContain('let me reason')
    expect(screen.getByText('42').tagName.toLowerCase()).toBe('strong')
  })

  it('folds an unclosed <think> (still streaming) so it cannot flood the chat', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'text', text: 'prefix <think>going on and on and on' },
    ] }} />)
    expect(container.querySelector('.think-body')?.textContent).toContain('going on and on')
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
    let container!: HTMLElement
    expect(() => { container = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Noop', input: undefined },
    ] }} />).container }).not.toThrow()
    expect(screen.getByText(/⚙ Noop/)).toBeInTheDocument()
    expandTools(container)
    expect(screen.getByText('undefined')).toBeInTheDocument()
  })

  it('renders an orphan tool-result without a matching tool-use', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-result', id: 't9', name: 'tool', output: 'lonely', isError: false },
    ] }} />)
    expandTools(container)
    expect(screen.getByText('lonely')).toBeInTheDocument()
  })

  it('splitThink: no tags → single normal segment; pairs and unclosed split correctly', () => {
    expect(splitThink('plain text')).toEqual([{ think: false, text: 'plain text' }])
    expect(splitThink('a<think>r</think>b')).toEqual([
      { think: false, text: 'a' }, { think: true, text: 'r' }, { think: false, text: 'b' },
    ])
    expect(splitThink('<think>unclosed tail')).toEqual([{ think: true, text: 'unclosed tail' }])
    // Lone closing tag, no opener (some models stream reasoning as plain content + a bare </think>):
    // everything up to </think> folds as reasoning, the rest is the answer.
    expect(splitThink('reasoning here</think>the answer')).toEqual([
      { think: true, text: 'reasoning here' }, { think: false, text: 'the answer' },
    ])
  })

  it('marks an error tool-result with the err class', () => {
    const { container } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Bash', input: {} },
      { kind: 'tool-result', id: 't1', name: 'Bash', output: 'boom', isError: true },
    ] }} />)
    expandTools(container)
    expect(container.querySelector('.result.err')).not.toBeNull()
  })

  it('replyMarkdown returns the prose, stripping <think> and ignoring tool parts', () => {
    expect(replyMarkdown([
      { kind: 'text', text: '<think>reasoning</think>The **answer**.' },
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ])).toBe('The **answer**.')
  })

  it('shows a copy button on an assistant reply with prose, none on a tool-only turn', () => {
    const { rerender } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'hello' }] }} />)
    expect(screen.getByLabelText('复制回复')).toBeInTheDocument()
    rerender(<Message msg={{ id: 'a2', role: 'assistant', parts: [{ kind: 'tool-use', id: 't1', name: 'Bash', input: {} }] }} />)
    expect(screen.queryByLabelText('复制回复')).toBeNull()
  })

  it('shows a share button when onShare is provided, and hides actions in share mode', () => {
    const { rerender } = render(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] }} onShare={() => {}} />)
    expect(screen.getByLabelText('分享')).toBeInTheDocument()
    rerender(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] }} onShare={() => {}} shareMode />)
    expect(screen.queryByLabelText('分享')).toBeNull()
    expect(screen.queryByLabelText('复制回复')).toBeNull()
  })

  it('in share mode renders only prose, dropping tool cards', () => {
    const { container } = render(<Message
      msg={{ id: 'a1', role: 'assistant', parts: [
        { kind: 'text', text: 'the prose' },
        { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] }}
      shareMode
    />)
    expect(screen.getByText('the prose')).toBeInTheDocument()
    expect(container.querySelector('.tool')).toBeNull()
  })
})
