import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Composer } from './Composer.js'

describe('Composer', () => {
  it('auto-focuses the textarea on mount', () => {
    render(<Composer disabled={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…')
    expect(document.activeElement).toBe(ta)
  })

  it('refocuses the textarea when disabled transitions from true to false (reply finishes)', () => {
    const { rerender } = render(<Composer disabled={true} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…')
    // While disabled the textarea cannot hold focus; re-enable it
    act(() => {
      rerender(<Composer disabled={false} onSend={() => {}} onStop={() => {}} />)
    })
    expect(document.activeElement).toBe(ta)
  })

  it('sends on Enter and clears', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(ta.value).toBe('')
  })

  it('does not send on Shift+Enter (newline)', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send whitespace-only input', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send the Enter that confirms an IME composition', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '你好' } })
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows Stop and fires onStop when disabled (thinking)', () => {
    const onStop = vi.fn()
    render(<Composer disabled={true} onSend={() => {}} onStop={onStop} />)
    fireEvent.click(screen.getByText('停止'))
    expect(onStop).toHaveBeenCalled()
  })
})
