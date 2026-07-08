import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog.js'

describe('ConfirmDialog', () => {
  let parentEsc: ((e: KeyboardEvent) => void) | null = null
  afterEach(() => { if (parentEsc) { window.removeEventListener('keydown', parentEsc); parentEsc = null } })

  it('renders nothing when closed', () => {
    const { container } = render(<ConfirmDialog open={false} message="x" onConfirm={() => {}} onCancel={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('x')).not.toBeInTheDocument()
  })

  it('Escape cancels and stops propagation (so a parent Esc handler cannot stack a second dialog)', () => {
    const onCancel = vi.fn()
    // Stand-in for the drawer's bubble-phase "close on Esc". The dialog's capture-phase handler on
    // window must fire first and stopPropagation, so this parent handler never sees the Escape.
    const seen = vi.fn()
    parentEsc = (e) => { if (e.key === 'Escape') seen() }
    window.addEventListener('keydown', parentEsc)
    render(<ConfirmDialog open message="放弃并切换？" onConfirm={() => {}} onCancel={onCancel} />)
    // Dispatch from a real element (document.body), not window itself — so capture-at-window runs
    // before the target/bubble phases, as it does for a real keypress in a focused field.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
  })

  it('clicking inside the card does not cancel (only the backdrop does)', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog open message="确认？" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('确认？')) // inside the card — stopPropagation guards it
    expect(onCancel).not.toHaveBeenCalled()
  })
})
