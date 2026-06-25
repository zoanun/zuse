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

  it('renders single newlines as line breaks (chat-style)', () => {
    // The model often writes status lines separated by plain newlines (no "- " list).
    // remark-breaks turns those soft breaks into <br> so they do not collapse onto one line.
    const { container } = render(<Markdown text={'✓ one\n● two\n○ three'} />)
    expect(container.querySelectorAll('br').length).toBe(2)
  })

  it('drops the bullet on list items that lead with a status glyph (✓/●/○)', () => {
    const { container } = render(<Markdown text={'- ✓ done\n- ● doing\n- ○ todo'} />)
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(3)
    // every glyph-led item is tagged task-list-item → CSS sets list-style:none (no disc)
    items.forEach((li) => expect(li.className).toContain('task-list-item'))
    expect(screen.getByText(/done/)).toBeInTheDocument()
  })
})
