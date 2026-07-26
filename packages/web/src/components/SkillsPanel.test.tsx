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
    fireEvent.click(screen.getByLabelText('禁用技能')) // brainstorm (enabled)
    expect(props.onUpdate).toHaveBeenCalledWith('brainstorm', { enabled: false })
    fireEvent.click(screen.getByLabelText('启用技能')) // deploy (disabled)
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
    fireEvent.click(screen.getAllByLabelText('编辑技能')[0]!)
    fireEvent.change(screen.getByDisplayValue('use when planning'), { target: { value: 'use rarely' } })
    fireEvent.change(screen.getByDisplayValue('Brainstorm body.'), { target: { value: 'New body.' } })
    fireEvent.click(screen.getByText('保存'))
    expect(props.onUpdate).toHaveBeenCalledWith('brainstorm', { description: 'use rarely', body: 'New body.' })
  })

  it('shows an empty state when there are no skills', () => {
    renderPanel({ skills: [] })
    expect(screen.getByText(/未找到技能/)).toBeInTheDocument()
  })

  describe('builtin skills (compiled in, no file on disk)', () => {
    const builtin = mk({ name: 'zuse-config', source: 'builtin' })

    it('shows a builtin badge, hides the edit button, keeps the toggle', () => {
      const props = renderPanel({ skills: [builtin] })
      const row = screen.getAllByRole('listitem')[0]!
      expect(within(row).getByText('builtin')).toBeInTheDocument()
      expect(within(row).getByText('builtin').className).toContain('skill-src-builtin')
      expect(screen.queryByLabelText('编辑技能')).not.toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('禁用技能'))
      expect(props.onUpdate).toHaveBeenCalledWith('zuse-config', { enabled: false })
    })

    it('still expands to show its description + body', () => {
      renderPanel({ skills: [builtin] })
      fireEvent.click(screen.getByText('zuse-config'))
      expect(screen.getByText('Brainstorm body.')).toBeInTheDocument()
    })

    it('non-builtin skills keep their edit button', () => {
      renderPanel({ skills: [builtin, mk({ name: 'brainstorm' })] })
      expect(screen.getAllByLabelText('编辑技能')).toHaveLength(1)
    })

    it('the hint explains builtin skills are toggle-only', () => {
      renderPanel()
      expect(screen.getByText(/内置技能/)).toBeInTheDocument()
    })
  })
})
