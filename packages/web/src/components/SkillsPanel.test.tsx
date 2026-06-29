import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { SkillItem } from '@zuse/protocol'
import { SkillsPanel } from './SkillsPanel.js'

const mk = (over: Partial<SkillItem> = {}): SkillItem => ({
  name: 'brainstorm', description: 'use when planning', body: 'Brainstorm body.', source: 'user', enabled: true, ...over,
})

function renderPanel(over: Partial<Parameters<typeof SkillsPanel>[0]> = {}) {
  const props = {
    skills: [mk({ name: 'brainstorm' }), mk({ name: 'deploy', source: 'project' as const, enabled: false })],
    onUpdate: vi.fn(),
    ...over,
  }
  render(<SkillsPanel {...props} />)
  return props
}

describe('SkillsPanel', () => {
  it('lists skills with source and reflects disabled state', () => {
    renderPanel()
    expect(screen.getByText('brainstorm')).toBeInTheDocument()
    expect(screen.getByText('deploy')).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    // brainstorm enabled, deploy disabled (skill-off)
    expect(rows[0]!.className).not.toContain('skill-off')
    expect(rows[1]!.className).toContain('skill-off')
  })

  it('clicking the toggle on an enabled skill disables it; on a disabled one enables it', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByLabelText('Disable skill')) // brainstorm (enabled)
    expect(props.onUpdate).toHaveBeenCalledWith('brainstorm', { enabled: false })
    fireEvent.click(screen.getByLabelText('Enable skill')) // deploy (disabled)
    expect(props.onUpdate).toHaveBeenCalledWith('deploy', { enabled: true })
  })

  it('clicking the name expands to show description + body', () => {
    renderPanel()
    fireEvent.click(screen.getByText('brainstorm'))
    expect(screen.getByText('use when planning')).toBeInTheDocument()
    expect(screen.getByText('Brainstorm body.')).toBeInTheDocument()
  })

  it('edit (✎) opens inline form; save fires onUpdate with description+body', () => {
    const props = renderPanel()
    fireEvent.click(screen.getAllByLabelText('Edit skill')[0]!)
    fireEvent.change(screen.getByDisplayValue('use when planning'), { target: { value: 'use rarely' } })
    fireEvent.change(screen.getByDisplayValue('Brainstorm body.'), { target: { value: 'New body.' } })
    fireEvent.click(screen.getByText('Save'))
    expect(props.onUpdate).toHaveBeenCalledWith('brainstorm', { description: 'use rarely', body: 'New body.' })
  })

  it('shows an empty state when there are no skills', () => {
    renderPanel({ skills: [] })
    expect(screen.getByText(/No skills/)).toBeInTheDocument()
  })
})
