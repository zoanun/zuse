import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { PersonaItem } from '@zuse/protocol'
import { PersonasPanel } from './PersonasPanel.js'

const mk = (over: Partial<PersonaItem> = {}): PersonaItem => ({
  id: 'p1', name: 'Reviewer', content: 'be terse', createdAt: '2026-06-26T00:00:00Z', updatedAt: '2026-06-26T00:00:00Z', ...over,
})

function renderPanel(over: Partial<Parameters<typeof PersonasPanel>[0]> = {}) {
  const props = {
    personas: [mk({ id: 'p1', name: 'Reviewer' }), mk({ id: 'p2', name: 'Mentor' })],
    activeId: 'p1' as string | null,
    onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onActivate: vi.fn(),
    ...over,
  }
  render(<PersonasPanel {...props} />)
  return props
}

describe('PersonasPanel', () => {
  it('lists personas and marks the active one', () => {
    renderPanel()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Mentor')).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]!.className).toContain('persona-active')
    expect(rows[1]!.className).not.toContain('persona-active')
  })

  it('clicking an inactive persona activates it; clicking the active one deactivates', () => {
    const props = renderPanel()
    const rows = screen.getAllByRole('listitem')
    // p2 is inactive → activate p2
    fireEvent.click(within(rows[1]!).getByLabelText('启用人设'))
    expect(props.onActivate).toHaveBeenCalledWith('p2')
    // p1 is active → deactivate (null)
    fireEvent.click(within(rows[0]!).getByLabelText('停用人设'))
    expect(props.onActivate).toHaveBeenCalledWith(null)
  })

  it('New reveals the form; submit fires onCreate with name+content', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText(/新增/))
    fireEvent.change(screen.getByPlaceholderText('例如 Reviewer'), { target: { value: 'Coach' } })
    fireEvent.change(screen.getByPlaceholderText(/人设指令/), { target: { value: 'encourage' } })
    fireEvent.click(screen.getByText('新增'))
    expect(props.onCreate).toHaveBeenCalledWith({ name: 'Coach', content: 'encourage' })
  })

  it('add form will not submit without name and content', () => {
    renderPanel()
    fireEvent.click(screen.getByText(/新增/))
    expect((screen.getByText('新增') as HTMLButtonElement).disabled).toBe(true)
  })

  it('edit (✎) opens inline form; save fires onUpdate', () => {
    const props = renderPanel()
    fireEvent.click(screen.getAllByLabelText('编辑人设')[0]!)
    fireEvent.change(screen.getByDisplayValue('be terse'), { target: { value: 'be very terse' } })
    fireEvent.click(screen.getByText('保存'))
    expect(props.onUpdate).toHaveBeenCalledWith('p1', { name: 'Reviewer', content: 'be very terse' })
  })

  it('delete requires inline confirm', () => {
    const props = renderPanel()
    const first = screen.getAllByRole('listitem')[0]!
    fireEvent.click(within(first).getByLabelText('删除人设'))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(first).getByLabelText('确认删除'))
    expect(props.onDelete).toHaveBeenCalledWith('p1')
  })

  it('shows an empty state when there are no personas', () => {
    renderPanel({ personas: [], activeId: null })
    expect(screen.getByText(/暂无人设/)).toBeInTheDocument()
  })
})
