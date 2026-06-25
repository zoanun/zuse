import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TodosPanel } from './TodosPanel.js'

describe('TodosPanel', () => {
  it('renders three states with a done count', () => {
    render(<TodosPanel todos={[
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]} />)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })
  it('renders nothing when empty', () => {
    const { container } = render(<TodosPanel todos={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
