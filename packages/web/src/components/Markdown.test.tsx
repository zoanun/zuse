import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders [-] task items as an in-progress marker while keeping GFM checkboxes', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [-] doing\n- [ ] todo'} />)
    // in-progress marker present (CSS-drawn square+dot, no text glyph)
    expect(container.querySelector('.cbx.doing')).not.toBeNull()
    expect(screen.getByText('doing')).toBeInTheDocument()
    // [x] and [ ] still render as GFM checkboxes
    expect(container.querySelectorAll('input[type=checkbox]').length).toBe(2)
  })

  it('renders single newlines as line breaks (chat-style)', () => {
    // Plain prose lines (non-task) are joined with <br> by remark-breaks.
    const { container } = render(<Markdown text={'line one\nline two\nline three'} />)
    expect(container.querySelectorAll('br').length).toBe(2)
  })

  it('converts glyph-led lines (✓/●/○), even without a "- " bullet, into task markers', () => {
    const { container } = render(<Markdown text={'✓ a\n● b\n○ c'} />)
    // ✓→done and ○→todo become native checkboxes (done one checked); ●→in-progress square
    expect(container.querySelectorAll('input[type=checkbox]').length).toBe(2)
    expect(container.querySelector('input[type=checkbox]:checked')).not.toBeNull()
    expect(container.querySelector('.cbx.doing')).not.toBeNull()
    // they became a list, not <br>-joined prose
    expect(container.querySelectorAll('li').length).toBe(3)
  })
})
