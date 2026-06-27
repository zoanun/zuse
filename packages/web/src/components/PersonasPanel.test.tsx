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
    fireEvent.click(within(rows[1]!).getByLabelText('Activate persona'))
    expect(props.onActivate).toHaveBeenCalledWith('p2')
    // p1 is active → deactivate (null)
    fireEvent.click(within(rows[0]!).getByLabelText('Deactivate persona'))
    expect(props.onActivate).toHaveBeenCalledWith(null)
  })

  it('New reveals the form; submit fires onCreate with name+content', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText(/New/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Reviewer'), { target: { value: 'Coach' } })
    fireEvent.change(screen.getByPlaceholderText(/Persona instructions/), { target: { value: 'encourage' } })
    fireEvent.click(screen.getByText('Add'))
    expect(props.onCreate).toHaveBeenCalledWith({ name: 'Coach', content: 'encourage' })
  })

  it('add form will not submit without name and content', () => {
    renderPanel()
    fireEvent.click(screen.getByText(/New/))
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('edit (✎) opens inline form; save fires onUpdate', () => {
    const props = renderPanel()
    fireEvent.click(screen.getAllByLabelText('Edit persona')[0]!)
    fireEvent.change(screen.getByDisplayValue('be terse'), { target: { value: 'be very terse' } })
    fireEvent.click(screen.getByText('Save'))
    expect(props.onUpdate).toHaveBeenCalledWith('p1', { name: 'Reviewer', content: 'be very terse' })
  })

  it('delete requires inline confirm', () => {
    const props = renderPanel()
    const first = screen.getAllByRole('listitem')[0]!
    fireEvent.click(within(first).getByLabelText('Delete persona'))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(first).getByLabelText('Confirm delete'))
    expect(props.onDelete).toHaveBeenCalledWith('p1')
  })

  it('shows an empty state when there are no personas', () => {
    renderPanel({ personas: [], activeId: null })
    expect(screen.getByText(/No personas/)).toBeInTheDocument()
  })
})
