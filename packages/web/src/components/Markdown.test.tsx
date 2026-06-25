import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders [-] task items as an in-progress marker while keeping GFM checkboxes', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [-] doing\n- [ ] todo'} />)
    // in-progress marker present
    expect(screen.getByText('●')).toBeInTheDocument()
    expect(screen.getByText('doing')).toBeInTheDocument()
    // [x] and [ ] still render as GFM checkboxes
    expect(container.querySelectorAll('input[type=checkbox]').length).toBe(2)
  })
})
