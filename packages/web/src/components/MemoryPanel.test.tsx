import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { MemoryItem } from '@zuse/protocol'
import { MemoryPanel, GLOBAL_FILTER } from './MemoryPanel.js'

const mk = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 1, type: 'user', content: 'remember the milk', project: '', hook: '', createdAt: '2026-06-26T00:00:00Z', updatedAt: '2026-06-26T00:00:00Z', ...over,
})

function renderPanel(over: Partial<Parameters<typeof MemoryPanel>[0]> = {}) {
  const props = {
    items: [
      mk({ id: 1, type: 'user', hook: 'always greet', project: '' }),
      mk({ id: 2, type: 'project', content: 'use pnpm here', project: 'zuse' }),
      mk({ id: 3, type: 'insight', content: 'the bug was a race', project: 'zuse' }),
    ],
    loading: false,
    error: null,
    query: '',
    onQueryChange: vi.fn(),
    projectFilter: '',
    onProjectFilterChange: vi.fn(),
    projectInfos: [{ slug: 'zuse', cwd: 'E:/ai-study/zuse' }],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  }
  render(<MemoryPanel {...props} />)
  return props
}

describe('MemoryPanel', () => {
  it('renders rows grouped by type with headings', () => {
    renderPanel()
    expect(screen.getByText('User')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Insight')).toBeInTheDocument()
    // hook preferred as the row label
    expect(screen.getByText('always greet')).toBeInTheDocument()
    // content shown when no hook
    expect(screen.getByText('use pnpm here')).toBeInTheDocument()
  })

  it('shows project tag and a global tag for empty project', () => {
    renderPanel()
    // tag shows the real working-directory path (mapped from the slug), not the slug
    expect(screen.getAllByText('E:/ai-study/zuse').length).toBeGreaterThan(0)
    expect(screen.getByText('global')).toBeInTheDocument()
  })

  it('typing in the search box fires onQueryChange', () => {
    const props = renderPanel()
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'race' } })
    expect(props.onQueryChange).toHaveBeenCalledWith('race')
  })

  it('changing the project filter fires onProjectFilterChange', () => {
    const props = renderPanel()
    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'zuse' } })
    expect(props.onProjectFilterChange).toHaveBeenCalledWith('zuse')
  })

  it('project filter <select> lists distinct projects plus All/Global', () => {
    renderPanel()
    const sel = screen.getByLabelText('Filter by project') as HTMLSelectElement
    const values = Array.from(sel.options).map((o) => o.value)
    expect(values).toEqual(['', GLOBAL_FILTER, 'zuse'])
  })

  it('Global filter shows only empty-project items', () => {
    renderPanel({ projectFilter: GLOBAL_FILTER })
    expect(screen.getByText('always greet')).toBeInTheDocument()
    expect(screen.queryByText('use pnpm here')).not.toBeInTheDocument()
  })

  it('New button reveals the add form; submit fires onCreate', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText(/New/))
    const textarea = screen.getByPlaceholderText('What to remember…')
    fireEvent.change(textarea, { target: { value: 'new memory' } })
    fireEvent.click(screen.getByText('Add'))
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'user', content: 'new memory' }))
  })

  it('add form does not submit empty content', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText(/New/))
    // submit button disabled when content empty
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true)
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('edit (✎) opens inline form; save fires onUpdate', () => {
    const props = renderPanel()
    const editBtns = screen.getAllByLabelText('Edit memory')
    fireEvent.click(editBtns[0]!)
    const textarea = screen.getByDisplayValue('remember the milk')
    fireEvent.change(textarea, { target: { value: 'updated content' } })
    fireEvent.click(screen.getByText('Save'))
    expect(props.onUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ content: 'updated content' }))
  })

  it('delete requires inline confirm before firing onDelete', () => {
    const props = renderPanel()
    const rows = screen.getAllByRole('listitem')
    const first = rows[0]!
    fireEvent.click(within(first).getByLabelText('Delete memory'))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(first).getByLabelText('Confirm delete'))
    expect(props.onDelete).toHaveBeenCalledWith(1)
  })

  it('canceling delete confirm does not fire onDelete', () => {
    const props = renderPanel()
    const first = screen.getAllByRole('listitem')[0]!
    fireEvent.click(within(first).getByLabelText('Delete memory'))
    fireEvent.click(within(first).getByLabelText('Cancel delete'))
    expect(props.onDelete).not.toHaveBeenCalled()
  })

  it('shows an empty state when there are no items', () => {
    renderPanel({ items: [] })
    expect(screen.getByText(/No memories/)).toBeInTheDocument()
  })

  it('renders an error banner when error is set', () => {
    renderPanel({ error: 'list memory failed: 500' })
    expect(screen.getByText('list memory failed: 500')).toBeInTheDocument()
  })
})
