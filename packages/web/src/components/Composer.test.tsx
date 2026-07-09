import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Composer, type ComposerHandle } from './Composer.js'
import { SLASH_COMMANDS } from './commands.js'
import { uploadImage } from '../state/manageApi.js'

// The upload entry points call uploadImage(file); mock it so tests don't hit the network.
// uploadedImageUrl is a pure path builder, kept real-ish here.
vi.mock('../state/manageApi.js', () => ({
  uploadImage: vi.fn(async (file: File) => ({ id: 'id-' + file.name, name: file.name, mediaType: 'image/png' })),
  uploadedImageUrl: (id: string) => '/api/uploads/' + id,
}))

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
    expect(onSend).toHaveBeenCalledWith('hello', undefined)
    expect(ta.value).toBe('')
  })

  it('still sends while thinking (mid-turn steer) — Shell routes it to a steer', () => {
    const onSend = vi.fn()
    render(<Composer thinking={true} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('插入消息到当前回合…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'wait, also do X' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('wait, also do X', undefined)
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

  it('Shift+Enter with the menu open does NOT run a command (leaves room for a newline)', () => {
    const onRunCommand = vi.fn()
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} commands={SLASH_COMMANDS} onRunCommand={onRunCommand} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/help' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onRunCommand).not.toHaveBeenCalled()
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

  it('does not recall history when the input is multi-line (arrows keep normal caret movement)', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={['old']} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'line1\nline2' } })
    const notPrevented = fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(ta.value).toBe('line1\nline2') // no recall — a multi-line draft is never hijacked
    expect(notPrevented).toBe(true) // default not prevented → the caret can still move
  })

  it('ArrowUp with empty history does not preventDefault (stays a live caret key)', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} history={[]} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    const notPrevented = fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(notPrevented).toBe(true) // no history → arrow is not swallowed
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

describe('Composer image upload', () => {
  const mockedUpload = vi.mocked(uploadImage)

  function pngFile(name = 'a.png', size = 8): File {
    return new File(['x'.repeat(size)], name, { type: 'image/png' })
  }
  function bigFile(name = 'huge.png'): File {
    const f = new File(['x'], name, { type: 'image/png' })
    Object.defineProperty(f, 'size', { value: 26 * 1024 * 1024 })
    return f
  }
  function fileInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector('input[type="file"]') as HTMLInputElement
  }

  it('pastes an image → uploads it → shows a thumbnail in the tray', async () => {
    mockedUpload.mockClear()
    const { container } = render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    const file = pngFile('pasted.png')
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: { files: [file], items: [] } })
    })
    expect(mockedUpload).toHaveBeenCalledWith(file)
    expect(await screen.findByAltText('pasted.png')).toBeInTheDocument()
    expect(container.querySelectorAll('.attach-thumb').length).toBe(1)
  })

  it('addImages (the whole-page drop entry point) uploads and shows a thumbnail', async () => {
    // Drop is now handled by Shell's whole-page drop zone, which forwards files here via the
    // imperative handle — so exercise addImages directly.
    mockedUpload.mockClear()
    const ref = createRef<ComposerHandle>()
    render(<Composer ref={ref} thinking={false} onSend={() => {}} onStop={() => {}} />)
    const file = pngFile('dropped.png')
    await act(async () => { ref.current!.addImages([file]) })
    expect(mockedUpload).toHaveBeenCalledWith(file)
    expect(await screen.findByAltText('dropped.png')).toBeInTheDocument()
  })

  it('addImages refuses while thinking (mid-turn) and surfaces a hint', async () => {
    mockedUpload.mockClear()
    const ref = createRef<ComposerHandle>()
    render(<Composer ref={ref} thinking onSend={() => {}} onStop={() => {}} />)
    await act(async () => { ref.current!.addImages([pngFile('x.png')]) })
    expect(mockedUpload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/回复生成中/)
  })

  it('picks an image via the paperclip file input → uploads it', async () => {
    mockedUpload.mockClear()
    const { container } = render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const input = fileInput(container)
    const file = pngFile('picked.png')
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    expect(mockedUpload).toHaveBeenCalledWith(file)
    expect(await screen.findByAltText('picked.png')).toBeInTheDocument()
  })

  it('caps at 10 images and shows an error when more are added', async () => {
    mockedUpload.mockClear()
    const { container } = render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const files = Array.from({ length: 11 }, (_, i) => pngFile(`f${i}.png`))
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files } })
    })
    await waitFor(() => expect(container.querySelectorAll('.attach-thumb').length).toBe(10))
    expect(screen.getByRole('alert')).toHaveTextContent(/10/)
    expect(mockedUpload).toHaveBeenCalledTimes(10)
  })

  it('skips a file larger than 25 MiB and shows an error', async () => {
    mockedUpload.mockClear()
    const { container } = render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files: [bigFile('huge.png')] } })
    })
    expect(mockedUpload).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.attach-thumb').length).toBe(0)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('auto-dismisses a transient attach error after a few seconds', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
      act(() => { fireEvent.change(fileInput(container), { target: { files: [bigFile('huge.png')] } }) })
      expect(screen.getByRole('alert')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(4100) })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the uploaded image refs then clears the tray', async () => {
    mockedUpload.mockClear()
    const onSend = vi.fn()
    const { container } = render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: { files: [pngFile('sent.png')], items: [] } })
    })
    // wait until the upload resolves and the item is 'done' (send button becomes enabled)
    await waitFor(() => expect(screen.getByLabelText('发送消息')).not.toBeDisabled())
    fireEvent.change(ta, { target: { value: 'here' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('here', [{ id: 'id-sent.png', name: 'sent.png', mediaType: 'image/png' }])
    expect(container.querySelectorAll('.attach-thumb').length).toBe(0)
  })

  it('blocks sending while an image is still uploading', async () => {
    mockedUpload.mockClear()
    // A never-resolving upload keeps the item in the 'uploading' state.
    mockedUpload.mockImplementationOnce(() => new Promise(() => {}))
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: { files: [pngFile('slow.png')], items: [] } })
    })
    fireEvent.change(ta, { target: { value: 'go' } })
    expect(screen.getByLabelText('发送消息')).toBeDisabled()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables the attach button while thinking', () => {
    render(<Composer thinking={true} onSend={() => {}} onStop={() => {}} />)
    expect(screen.getByLabelText('添加图片')).toBeDisabled()
  })
})
