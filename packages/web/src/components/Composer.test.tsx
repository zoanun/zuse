import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Composer } from './Composer.js'

describe('Composer', () => {
  it('auto-focuses the textarea on mount', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…')
    expect(document.activeElement).toBe(ta)
  })

  it('refocuses the textarea when thinking transitions from true to false (reply finishes)', () => {
    const { rerender } = render(<Composer thinking={true} onSend={() => {}} onStop={() => {}} />)
    // While thinking the composer stays enabled (steer), so target it by its thinking placeholder.
    const ta = screen.getByPlaceholderText('插入消息到当前回合…')
    act(() => {
      rerender(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    })
    expect(document.activeElement).toBe(ta)
  })

  it('sends on Enter and clears', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(ta.value).toBe('')
  })

  it('still sends while thinking (mid-turn steer) — Shell routes it to a steer', () => {
    const onSend = vi.fn()
    render(<Composer thinking={true} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('插入消息到当前回合…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'wait, also do X' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('wait, also do X')
    expect(ta.value).toBe('')
  })

  it('does not send on Shift+Enter (newline)', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send whitespace-only input', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send the Enter that confirms an IME composition', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '你好' } })
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows Stop and fires onStop while thinking', () => {
    const onStop = vi.fn()
    render(<Composer thinking={true} onSend={() => {}} onStop={onStop} />)
    fireEvent.click(screen.getByText('停止'))
    expect(onStop).toHaveBeenCalled()
  })
})
