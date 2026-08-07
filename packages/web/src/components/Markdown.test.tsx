import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Markdown, SessionContext } from './Markdown.js'
import { __resetActivePreview, useActiveRun } from '../preview/activePreview.js'
import { Rail } from '../preview/Rail.js'
import type { HostMessage } from '../preview/types.js'

afterEach(() => { __resetActivePreview(); cleanup() })

const SID = 's-test'

/**
 * `<Markdown>` + `<Rail>` 的最小组合，形状与 `Shell` 的 `.main-body` 一致：
 * 预览已经不在代码块内部了（PR1 把它搬进右栏），所以想端到端验
 * 「代码块 → store → 右栏 iframe」这条链，就必须把两边一起挂上。
 *
 * **这个 harness 不是为了让老测试变绿而糊的壳**：它锁的路径（`<pre>` 内联 ref detach →
 * code 抖成空串 → 重编译）在旧结构下是真 bug，见下面两条用例的注释。
 */
function Harness({ text, messageId = 'm1' }: { text: string; messageId?: string }) {
  const run = useActiveRun(SID)
  return (
    <div className="main-body">
      <SessionContext.Provider value={SID}>
        <Markdown text={text} messageId={messageId} />
      </SessionContext.Provider>
      {run ? <Rail run={run} /> : null}
    </div>
  )
}

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
    const { container } = render(<Harness text={'```jsx\nconst a = 1\n```'} />)

    fireEvent.click(container.querySelector('.code-run')!)
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin })
    const tokenOf = (): string => /var TOKEN = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')![1]!
    const token = tokenOf()
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
    // 右栏也不该被这次重渲染顶掉重挂：同一个 iframe 元素、同一个 token。
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(tokenOf()).toBe(token)
  })

  /**
   * 上一条依赖「点复制会触发重渲染」这个间接路径；这条直接钉住机制本身，
   * 免得将来 useCopy 换了实现就把上面那条变成空跑。
   *
   * **搬到右栏后这条锁的东西变了，但没变弱**：`code` 现在是点「运行」那一刻取的快照
   * （设计 §3.2），所以 detach 把它冲成空串**不再表现为重编译，而是表现为「预览里空空如也」**
   * —— 更难发现。因此这里改成：先来几轮无关重渲染，**再**点运行，断言送进 guest 的
   * 产物里真的有代码。`Markdown.tsx` 里 `if (!el) return` 那行删掉就红。
   */
  it('重渲染之后再点「运行」，快照里必须是真代码（内联 ref 的 detach 陷阱）', async () => {
    const sent: HostMessage[] = []
    const fakeWin = { postMessage: (m: HostMessage) => { sent.push(m) } }
    const text = '```jsx\nconst a = 1\n```'
    const { container, rerender } = render(<Harness text={text} />)
    // 文本一字未改的重渲染。（React 19.2 实测：仅函数身份变了不会解绑重绑；这里仍然照跑，
    // 因为这条锁的是「点运行时拿到的快照」，不依赖 React 哪一版的 ref 时序。）
    for (let i = 0; i < 3; i++) {
      rerender(<Harness text={text} />)
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    }

    fireEvent.click(container.querySelector('.code-run')!)
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin })
    const token = /var TOKEN = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')![1]!
    const ev = new MessageEvent('message', { data: { type: 'ready', token } })
    Object.defineProperty(ev, 'source', { value: fakeWin })
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    act(() => { window.dispatchEvent(ev) })

    const evals = () => sent.filter((m) => m.type === 'eval') as Array<Extract<HostMessage, { type: 'eval' }>>
    expect(evals()).toHaveLength(1)
    expect(evals()[0]!.js).toContain('const a = 1') // 快照不是空串

    // 运行中再来几轮重渲染，同样不该重跑。
    for (let i = 0; i < 3; i++) {
      rerender(<Harness text={text} />)
      await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    }
    expect(evals()).toHaveLength(1)
  })

  /**
   * **`Markdown.tsx` 里 `if (!el) return` 那行不许删。**
   *
   * 它当初的理由（「内联 ref 每次渲染都解绑重绑 → code 抖成空串」）在 React 19.2 上
   * 实测已经不成立：只有函数身份变了 React 不再 `ref(null)`（连续 5 次重渲染实测 code 恒定）。
   * 但代码块**真的被移走**时 React 确实会 `ref(null)` —— 删掉这行就是
   * `TypeError: Cannot read properties of null (reading 'textContent')`，整棵树炸。
   * 上面那条「快照里必须是真代码」抓不到删除（它只在挂着的时候取值），所以补这一条。
   */
  it('代码块被换掉 / 组件卸载时不得抛（ref detach 拿到 null）', () => {
    const text = '```jsx\nconst a = 1\n```'
    const { rerender, unmount } = render(<Harness text={text} />)
    expect(() => rerender(<Harness text={'换成一段没有代码块的正文'} />)).not.toThrow()
    rerender(<Harness text={text} />)
    expect(() => unmount()).not.toThrow()
  })
})
