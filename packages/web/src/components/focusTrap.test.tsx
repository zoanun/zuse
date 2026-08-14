import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useFocusTrap } from './useFocusTrap.js'
import { ConfirmDialog } from './ConfirmDialog.js'

afterEach(cleanup)

/**
 * `aria-modal="true"` 是对辅助技术**下的承诺**：这层之外的东西不可达。
 * 回溯审计发现 ConfirmDialog / ManageDrawer 都写了这个属性却没有任何焦点管理 ——
 * 弹窗开着时 Tab 照样跑到背景上。读屏软件按这个属性把背景当「不存在」播报，
 * 用户却能 Tab 到那些「不存在」的控件上，**比不写这个属性更糟**。
 */

function Harness({ startOpen = true }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(open, ref)
  return (
    <div>
      <button data-testid="outside">背景按钮</button>
      {open ? (
        <div ref={ref} tabIndex={-1} data-testid="card" role="alertdialog" aria-modal="true">
          <button data-testid="a">A</button>
          <button data-testid="b">B</button>
        </div>
      ) : null}
      <button data-testid="close-it" onClick={() => setOpen(false)}>关</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  it('打开时焦点进入容器本身（而不是落在某个按钮上）', () => {
    render(<Harness />)
    // 刻意不落在按钮上：ConfirmDialog 的最后一个按钮是销毁性动作（「放弃修改」），
    // 焦点落在它上面等于把销毁操作放在回车键底下。
    expect(document.activeElement).toBe(screen.getByTestId('card'))
  })

  it('焦点在容器上时按 Tab 进入第一个控件（否则第一下 Tab 就跑出去了）', () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('a'))
  })

  it('Shift+Tab 从容器进入最后一个控件', () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('b'))
  })

  it('走到最后一个再 Tab 回到第一个（不跑到背景上）', () => {
    render(<Harness />)
    screen.getByTestId('b').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('a'))
    expect(document.activeElement).not.toBe(screen.getByTestId('outside'))
  })

  it('在第一个上 Shift+Tab 回到最后一个', () => {
    render(<Harness />)
    screen.getByTestId('a').focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('b'))
  })

  it('关闭后把焦点还给打开它的那个元素', () => {
    render(<Harness startOpen={false} />)
    const opener = screen.getByTestId('outside')
    opener.focus()
    expect(document.activeElement).toBe(opener)
    // 这个 Harness 没有「开」按钮，直接换一个已开的实例不好模拟还原，
    // 所以用同一棵树：先聚焦背景按钮，再挂载弹窗（startOpen 切换靠重渲染）。
    cleanup()
    const { rerender } = render(<Toggle open={false} />)
    screen.getByTestId('outside').focus()
    const before = document.activeElement
    rerender(<Toggle open />)
    expect(document.activeElement).toBe(screen.getByTestId('card'))
    rerender(<Toggle open={false} />)
    expect(document.activeElement).toBe(before)
  })

  it('关着的时候不管焦点', () => {
    render(<Harness startOpen={false} />)
    const outside = screen.getByTestId('outside')
    outside.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(outside)
  })
})

function Toggle({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(open, ref)
  return (
    <div>
      <button data-testid="outside">背景按钮</button>
      {open ? (
        <div ref={ref} tabIndex={-1} data-testid="card">
          <button data-testid="a">A</button>
        </div>
      ) : null}
    </div>
  )
}

describe('ConfirmDialog 真的接上了围栏', () => {
  it('打开后 Tab 不会跑到背景按钮上', () => {
    render(
      <div>
        <button data-testid="outside">背景</button>
        <ConfirmDialog open message="确定？" onConfirm={() => {}} onCancel={() => {}} />
      </div>,
    )
    // 连按几次 Tab，焦点必须始终留在弹窗里。
    for (let i = 0; i < 6; i++) fireEvent.keyDown(window, { key: 'Tab' })
    const card = document.querySelector('.confirm-card')
    expect(card).not.toBeNull()
    expect(card!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(screen.getByTestId('outside'))
  })
})
