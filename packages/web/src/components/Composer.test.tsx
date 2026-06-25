import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer.js'

describe('Composer', () => {
  it('sends on Enter and clears', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('Message zuse…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(ta.value).toBe('')
  })

  it('shows Stop and fires onStop when disabled (thinking)', () => {
    const onStop = vi.fn()
    render(<Composer disabled={true} onSend={() => {}} onStop={onStop} />)
    fireEvent.click(screen.getByText('Stop'))
    expect(onStop).toHaveBeenCalled()
  })
})
