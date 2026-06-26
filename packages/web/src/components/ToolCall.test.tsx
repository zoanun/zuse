import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolCall } from './ToolCall.js'
import type { Part } from '../state/types.js'

const use = (name: string, input: unknown): Extract<Part, { kind: 'tool-use' }> => ({ kind: 'tool-use', id: 't1', name, input })

describe('ToolCall', () => {
  it('renders an Edit as a +/- line diff, not raw JSON', () => {
    const { container } = render(
      <ToolCall use={use('Edit', { file_path: 'test.md', old_string: 'a\nB old\nc', new_string: 'a\nB new\nc' })} />,
    )
    // file shown in the head
    expect(screen.getByText('test.md')).toBeInTheDocument()
    // changed line appears as a removed + an added row; unchanged lines are context
    expect(container.querySelector('.edit-diff .dl.del')?.textContent).toContain('B old')
    expect(container.querySelector('.edit-diff .dl.add')?.textContent).toContain('B new')
    expect(container.querySelectorAll('.edit-diff .dl.ctx').length).toBe(2) // 'a' and 'c'
    // not the raw JSON args
    expect(container.querySelector('.args')).toBeNull()
  })

  it('renders a MultiEdit as one diff per edit', () => {
    const { container } = render(
      <ToolCall use={use('MultiEdit', { file_path: 'x.ts', edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'two', new_string: 'TWO' },
      ] })} />,
    )
    expect(container.querySelectorAll('.edit-diff').length).toBe(2)
  })

  it('renders a Write as file-in-head + content box, not raw JSON', () => {
    const { container } = render(
      <ToolCall use={use('Write', { file_path: 'doc.md', content: '# Title\nline one\nline two' })} />,
    )
    expect(screen.getByText('doc.md')).toBeInTheDocument()
    const body = container.querySelector('.write-body')
    expect(body?.textContent).toContain('# Title')
    expect(body?.textContent).toContain('line two')
    expect(container.querySelector('.args')).toBeNull()
  })

  it('renders a Read as file-in-head with no args box (content shows in result)', () => {
    const { container } = render(
      <ToolCall
        use={use('Read', { file_path: 'a.ts' })}
        result={{ kind: 'tool-result', id: 't1', name: 'Read', output: 'file contents here', isError: false }}
      />,
    )
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(container.querySelector('.args')).toBeNull()
    expect(container.querySelector('.result')?.textContent).toContain('file contents here')
  })

  it('shows the pattern in the head for Glob/Grep with no args box', () => {
    const { container } = render(
      <ToolCall
        use={use('Glob', { pattern: '**/test.md' })}
        result={{ kind: 'tool-result', id: 't1', name: 'Glob', output: 'a/test.md\nb/test.md', isError: false }}
      />,
    )
    expect(screen.getByText('**/test.md')).toBeInTheDocument()
    expect(container.querySelector('.args')).toBeNull()
    expect(container.querySelector('.result')?.textContent).toContain('a/test.md')
  })

  it('renders Bash as a command box with the description in the head', () => {
    const { container } = render(
      <ToolCall use={use('Bash', { command: 'curl -s https://x | grep y', description: 'fetch and filter' })} />,
    )
    expect(screen.getByText('fetch and filter')).toBeInTheDocument()
    expect(container.querySelector('.bash-cmd')?.textContent).toContain('curl -s https://x | grep y')
    expect(container.querySelector('.args')).toBeNull()
  })

  it('renders Agent as a prompt box with the description in the head', () => {
    const { container } = render(
      <ToolCall use={use('Agent', { description: 'find the bug', prompt: 'Search the repo for the race condition.' })} />,
    )
    expect(screen.getByText('find the bug')).toBeInTheDocument()
    expect(container.querySelector('.write-body')?.textContent).toContain('race condition')
  })

  it('shows the headline arg in the head for WebFetch/WebSearch/Skill (no args box)', () => {
    const { container, rerender } = render(<ToolCall use={use('WebFetch', { url: 'https://example.com' })} />)
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(container.querySelector('.args')).toBeNull()
    rerender(<ToolCall use={use('WebSearch', { query: 'opus 4.8 release' })} />)
    expect(screen.getByText('opus 4.8 release')).toBeInTheDocument()
    rerender(<ToolCall use={use('Skill', { name: 'brainstorming' })} />)
    expect(screen.getByText('brainstorming')).toBeInTheDocument()
  })

  it('renders Memory with an action·type head and the content below', () => {
    const { container } = render(
      <ToolCall use={use('Memory', { action: 'save', type: 'insight', content: 'the bug was a race' })} />,
    )
    expect(screen.getByText('save · insight')).toBeInTheDocument()
    expect(container.querySelector('.write-body')?.textContent).toContain('the bug was a race')
  })

  it('renders Lsp as operation: symbol in the head', () => {
    render(<ToolCall use={use('Lsp', { operation: 'definition', symbol: 'ToolCall' })} />)
    expect(screen.getByText('definition: ToolCall')).toBeInTheDocument()
  })

  it('falls back to raw-JSON args for unrecognised tools', () => {
    const { container } = render(<ToolCall use={use('SomethingNew', { foo: 'bar' })} />)
    expect(container.querySelector('.edit-diff')).toBeNull()
    expect(container.querySelector('.write-body')).toBeNull()
    expect(container.querySelector('.args')?.textContent).toContain('bar')
  })
})
