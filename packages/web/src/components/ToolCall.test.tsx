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

  it('falls back to raw-JSON args for other tools', () => {
    const { container } = render(<ToolCall use={use('Bash', { command: 'ls -la' })} />)
    expect(container.querySelector('.edit-diff')).toBeNull()
    expect(container.querySelector('.write-body')).toBeNull()
    expect(container.querySelector('.args')?.textContent).toContain('ls -la')
  })
})
