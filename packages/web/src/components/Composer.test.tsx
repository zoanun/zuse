import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Composer } from './Composer.js'
import { SLASH_COMMANDS } from './commands.js'

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
    fireEvent.click(screen.getByLabelText('停止'))
    expect(onStop).toHaveBeenCalled()
  })
})

describe('Composer slash menu', () => {
  it('shows a filtered command menu while input starts with "/"', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/co' } })
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.queryByText('/clear')).not.toBeInTheDocument()
  })

  it('hides the menu when input has no leading slash', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
  })

  it('clicking a menu item runs it and clears input', () => {
    const onRunCommand = vi.fn()
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/comp' } })
    fireEvent.click(screen.getByText('/compact'))
    expect(onRunCommand).toHaveBeenCalledWith(SLASH_COMMANDS.find((c) => c.name === '/compact'))
    expect(ta.value).toBe('')
  })
})

describe('Composer slash menu keyboard', () => {
  it('ArrowDown moves the highlight; Enter runs the highlighted command', () => {
    const onRunCommand = vi.fn()
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/' } })
    // first item is /compact; ArrowDown → /clear
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onRunCommand).toHaveBeenCalledWith(SLASH_COMMANDS.find((c) => c.name === '/clear'))
    expect(onSend).not.toHaveBeenCalled() // Enter picked a command, did NOT send
  })

  it('Tab runs the highlighted command', () => {
    const onRunCommand = vi.fn()
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/comp' } })
    fireEvent.keyDown(ta, { key: 'Tab' })
    expect(onRunCommand).toHaveBeenCalledWith(SLASH_COMMANDS.find((c) => c.name === '/compact'))
  })

  it('Escape closes the menu without running or clearing input', () => {
    const onRunCommand = vi.fn()
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/comp' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onRunCommand).not.toHaveBeenCalled()
    expect(ta.value).toBe('/comp')
    expect(screen.queryByText('/compact')).not.toBeInTheDocument() // menu closed
  })
})

describe('Composer input history', () => {
  it('ArrowUp recalls the most recent history entry, then older', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={['first', 'second']} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(ta.value).toBe('second')
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(ta.value).toBe('first')
    fireEvent.keyDown(ta, { key: 'ArrowUp' }) // clamp at oldest
    expect(ta.value).toBe('first')
  })

  it('ArrowDown walks back toward the draft and restores it', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={['first', 'second']} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'draft' } })
    fireEvent.keyDown(ta, { key: 'ArrowUp' }) // → 'second'
    fireEvent.keyDown(ta, { key: 'ArrowDown' }) // → back to 'draft'
    expect(ta.value).toBe('draft')
  })

  it('does not recall history when input starts with "/" (command-input state)', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={['first']} commands={SLASH_COMMANDS} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/comp' } })
    fireEvent.keyDown(ta, { key: 'Escape' }) // dismiss menu so it's not the menu handling arrows
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(ta.value).toBe('/comp') // unchanged — no history recall
  })

  it('does not recall history on ArrowUp when caret is not on the first line (multiline)', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={['old']} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'line1\nline2' } })
    ta.selectionStart = ta.selectionEnd = ta.value.length // caret on last line
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(ta.value).toBe('line1\nline2') // caret moves within textarea; no recall
  })
})

describe('Composer Esc-to-stop and disabled send', () => {
  it('Escape stops the turn while thinking and menu is closed', () => {
    const onStop = vi.fn()
    render(<Composer thinking={true} onSend={() => {}} onStop={onStop} />)
    const ta = screen.getByPlaceholderText('插入消息到当前回合…') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onStop).toHaveBeenCalled()
  })

  it('Escape does not stop when not thinking', () => {
    const onStop = vi.fn()
    render(<Composer thinking={false} onSend={() => {}} onStop={onStop} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('Escape closes the menu instead of stopping, even while thinking', () => {
    const onStop = vi.fn()
    const onRunCommand = vi.fn()
    render(<Composer thinking={true} onSend={() => {}} onStop={onStop} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('插入消息到当前回合…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/comp' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onStop).not.toHaveBeenCalled() // menu-close took precedence
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
  })

  it('disables the send button when input is empty or whitespace', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const btn = screen.getByLabelText('发送消息')
    expect(btn).toBeDisabled()
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hi' } })
    expect(btn).not.toBeDisabled()
  })
})
