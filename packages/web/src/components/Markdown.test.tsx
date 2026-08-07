import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Markdown } from './Markdown.js'
import { __resetActivePreview } from '../preview/activePreview.js'
import type { HostMessage } from '../preview/types.js'

afterEach(() => { __resetActivePreview(); cleanup() })

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

describe('CodeBlock —— 预览不该被无关重渲染踢一脚', () => {
  /**
   * **真浏览器抓到的现场**：预览开着时点一下同一个代码块的「复制」，demo 的计数器从 3 归 0
   * （`useCopy` 的 `setCopied(true)` 触发重渲染，1.5 秒后 `setCopied(false)` 再来一遍）。
   *
   * 根因不在 `PreviewFrame`（它的编译 effect 依赖已经是 `spec.kind`/`spec.code` 两个原始值），
   * 而在下面这个 `<pre>` 的**内联 ref 回调**：内联箭头每次渲染都是新身份，React 会
   * 先 `ref(null)` 再 `ref(el)`。detach 那一下 `el` 是 null → `textContent` 取成 `''`
   * → `setCode('')`，于是 `code` 在**每次重渲染**都要 `TEXT → '' → TEXT` 抖一圈。
   * 对 effect 而言那是两次真实的依赖变化，防抖只能把这一圈压成**一次**重编译重跑 ——
   * 压不成零。所以 detach 时必须直接返回，不能拿 null 去冲掉已经取到的代码。
   *
   * 这条测试是端到端的（Markdown → CodeBlock → PreviewFrame → postMessage），
   * 因为单看任何一层都是「对的」，bug 只在拼起来时出现。
   */
  it('预览开着时点「复制」，不得重新下发 eval', async () => {
    const sent: HostMessage[] = []
    const fakeWin = { postMessage: (m: HostMessage) => { sent.push(m) } }
    const { container } = render(<Markdown text={'```jsx\nconst a = 1\n```'} />)

    fireEvent.click(container.querySelector('.code-run')!)
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin })
    const token = /var TOKEN = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')![1]!
    const ready = (): void => {
      const ev = new MessageEvent('message', { data: { type: 'ready', token } })
      Object.defineProperty(ev, 'source', { value: fakeWin })
      act(() => { window.dispatchEvent(ev) })
    }
    const settle = async (): Promise<void> => {
      await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    }
    await settle()
    ready()
    const evals = (): HostMessage[] => sent.filter((m) => m.type === 'eval')
    expect(evals()).toHaveLength(1)

    // jsdom 没有 navigator.clipboard，不打这个桩的话 useCopy 直接静默返回、
    // 根本不会 setCopied → 这条测试就变成永远绿的空跑。
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    })
    fireEvent.click(container.querySelector('.code-copy')!)
    await settle()
    expect(container.querySelector('.code-copy')!.textContent).toContain('已复制') // 状态真的变了
    await settle() // 跨过 1.5s 后的 setCopied(false)，那是第二次重渲染
    await settle()
    await settle()
    expect(evals()).toHaveLength(1)
  })

  /**
   * 上一条依赖「点复制会触发重渲染」这个间接路径；这条直接钉住机制本身，
   * 免得将来 useCopy 换了实现就把上面那条变成空跑。
   */
  it('任何一次重渲染都不得让 code 抖成空串（内联 ref 的 detach 陷阱）', async () => {
    const sent: HostMessage[] = []
    const fakeWin = { postMessage: (m: HostMessage) => { sent.push(m) } }
    const { container, rerender } = render(<Markdown text={'```jsx\nconst a = 1\n```'} />)
    fireEvent.click(container.querySelector('.code-run')!)
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin })
    const token = /var TOKEN = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')![1]!
    const ev = new MessageEvent('message', { data: { type: 'ready', token } })
    Object.defineProperty(ev, 'source', { value: fakeWin })
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    act(() => { window.dispatchEvent(ev) })
    expect(sent.filter((m) => m.type === 'eval')).toHaveLength(1)

    // 文本一字未改的重渲染，来几次都不该重跑。
    for (let i = 0; i < 3; i++) {
      rerender(<Markdown text={'```jsx\nconst a = 1\n```'} />)
      await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    }
    expect(sent.filter((m) => m.type === 'eval')).toHaveLength(1)
  })
})
