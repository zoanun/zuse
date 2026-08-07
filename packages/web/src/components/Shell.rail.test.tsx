import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ServerMessage, SessionEvent } from '@zuse/protocol'
import { StoreProvider, useStore } from '../state/store.js'
import { Shell } from './Shell.js'
import { __resetActivePreview } from '../preview/activePreview.js'

/**
 * 右侧工作栏的整棵树的锁（设计 §7）。**刻意跑真的 `<Shell/>`**，不是复刻一个形状相同的
 * harness —— 这里要锁的全部是「Shell 的 JSX 长什么样」，复刻一份等于把被测对象也一起复刻了。
 */

class FakeWS {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.() }
}

function mockLocalStorage(initial: Record<string, string> = {}): void {
  const store: Record<string, string> = { ...initial }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
}

let captured: ReturnType<typeof useStore> | null = null
function Consumer(): null { captured = useStore(); return null }

afterEach(() => { __resetActivePreview(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); captured = null })

function mount(sessionId = 'sess-a') {
  vi.stubGlobal('WebSocket', FakeWS)
  mockLocalStorage({ 'zuse.sessionId': sessionId })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => (url.startsWith('/api/sessions') ? [] : {}),
  })) as unknown as typeof fetch)
  return render(<StoreProvider><Shell /><Consumer /></StoreProvider>)
}

const ev = (event: SessionEvent): ServerMessage => ({ type: 'event', event } as ServerMessage)

/**
 * 灌一条助手消息。
 *
 * **连续的 text-delta 会被 reducer 合并成同一个 text part**（reducer.ts:47），所以想造出
 * 「多个 text part」必须在中间插一次工具调用 —— 传 `null` 就是插工具。
 */
function seed(chunks: Array<string | null>, id = 'a1'): void {
  act(() => {
    captured!.dispatch({ kind: 'server', msg: ev({ type: 'message-start', id } as SessionEvent) })
    let n = 0
    for (const c of chunks) {
      if (c === null) captured!.dispatch({ kind: 'server', msg: ev({ type: 'tool-use', id: 't' + (++n), name: 'Read', input: {} } as unknown as SessionEvent) })
      else captured!.dispatch({ kind: 'server', msg: ev({ type: 'text-delta', text: c } as SessionEvent) })
    }
  })
}

const FENCE = (name: string) => '正文\n\n```jsx\nconst ' + name + ' = 1\n```\n'
const tokenOf = (f: Element): string => /var TOKEN = "([^"]+)"/.exec(f.getAttribute('srcdoc') ?? '')![1]!

describe('右栏 —— `.main-body` 永远渲染（设计 §4.1 / P0-1）', () => {
  /**
   * 写成 `hasRail ? <div className="main-body">{chat}{rail}</div> : <main className="chat">…</main>`
   * 会在右栏每次出现/消失时**卸载并重建 MessageList + Composer**：Composer 里没发出的草稿没了、
   * `.stream` 的滚动位置回到顶（MessageList.tsx:20-21 的 endRef 会把它拽到底）。
   * 而右栏在一个回合里可以出现/消失好几次。
   *
   * 断言用的是 **DOM 节点身份**（`toBe`，同一个对象）而不是 scrollTop：jsdom 没有布局，
   * scrollTop 恒为 0，拿它断言是空跑。「节点没被换掉」正是滚动位置与草稿得以保住的**机制本身**。
   */
  it('右栏出现/消失，聊天树（.stream / textarea）不重建，草稿还在', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())

    const body = container.querySelector('.main-body')!
    const stream = container.querySelector('.stream')!
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '还没发出去的草稿' } })
    expect(ta.value).toBe('还没发出去的草稿')

    // **必须重新查 DOM**：重建之后旧引用是一个脱离文档的节点，它身上的 value 还在，
    // 拿它断言就是空跑。
    const draft = (): string | undefined => (container.querySelector('textarea') as HTMLTextAreaElement | null)?.value

    // 开右栏
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })
    expect(container.querySelector('.rail')).not.toBeNull()
    expect(draft()).toBe('还没发出去的草稿')
    expect(container.querySelector('.main-body')).toBe(body)   // 同一个节点，没重建
    expect(container.querySelector('.stream')).toBe(stream)
    expect(container.querySelector('textarea')).toBe(ta)

    // 关右栏（用 `.preview-bar` 上那个唯一的关闭按钮 —— 右栏没有第二个头部，设计 §5）
    expect(container.querySelectorAll('.preview-close')).toHaveLength(1)
    act(() => { fireEvent.click(container.querySelector('.preview-close')!) })
    expect(container.querySelector('.rail')).toBeNull()
    expect(draft()).toBe('还没发出去的草稿')
    expect(container.querySelector('.main-body')).toBe(body)
    expect(container.querySelector('.stream')).toBe(stream)
    expect(container.querySelector('textarea')).toBe(ta)
  })

  it('没有右栏时 .main-body 也在（它不是右栏的包装）', () => {
    const { container } = mount()
    expect(container.querySelector('.main-body')).not.toBeNull()
    expect(container.querySelector('.rail')).toBeNull()
  })
})

describe('右栏 —— run 归属会话（设计 §3.3 / P0-2）', () => {
  it('会话 A 开预览 → 切到会话 B → 右栏为空', async () => {
    const { container } = mount('sess-a')
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })
    expect(container.querySelector('.rail')).not.toBeNull()

    await act(async () => { await captured!.switchSession('sess-b') })
    expect(container.querySelector('.rail')).toBeNull()

    // 再切回 A 也不该「复活」—— store 必须真的被清干净（选择器过滤只是同步止血，
    // Shell 的 useEffect(closeRun, [currentSessionId]) 才是清场的那一手）。
    await act(async () => { await captured!.switchSession('sess-a') })
    expect(container.querySelector('.rail')).toBeNull()
  })
})

describe('右栏 —— iframe 身份必须活过布局变化（设计 §7.1 / P0-4）', () => {
  /**
   * **断言的是 iframe 的身份，不是计数器。**
   *
   * 计数器那条（「拖动分栏后还是 3」）在当前实现下必然通过：编译 effect 只依赖
   * `[kind, code, push, send]`，右栏架构下前两个是 store 里的冻结字符串、后两个恒稳定，
   * 布局怎么变都动不到它们 —— 那是空跑护栏。
   *
   * 真正会坏的是**换子树**：`narrow ? <Overlay><PreviewFrame/></Overlay> : <PreviewFrame/>`
   * 跨断点那一刻 PreviewFrame 换位置 → `token`（`useMemo(...,[])` + ++seq）重生 →
   * 新 document → demo 归零。token 是确定性的、不用等，所以拿它当主断言。
   */
  it('容器宽度跨过 900px 断点来回变，iframe 不重挂（同一个元素、同一个 token）', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })

    const body = container.querySelector('.main-body') as HTMLElement
    const iframe = container.querySelector('iframe')!
    const token = tokenOf(iframe)
    const rail = container.querySelector('.rail')!
    expect(rail.parentElement).toBe(body)

    // 1400 → 800 → 400 → 1400：并排 → 覆盖式 → 更窄 → 回到并排，各跨一次断点。
    for (const w of [1400, 800, 400, 1400]) {
      await act(async () => {
        body.style.width = w + 'px'
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
        window.dispatchEvent(new Event('resize'))
        await Promise.resolve()
      })
    }

    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    // **主断言：token 身份。** 重挂必变（useMemo(...,[]) + ++seq），且是确定性的、不用等。
    expect(tokenOf(container.querySelector('iframe')!)).toBe(token)
    expect(container.querySelector('iframe')).toBe(iframe)      // 同一个 DOM 节点
    expect(container.querySelector('.rail')).toBe(rail)
    expect(container.querySelector('.rail')!.parentElement).toBe(body) // 结构没改，只该换 class
  })
})

describe('右栏 —— 进出分享模式不该顶掉 run（设计 §3.4 / P0-3）', () => {
  /**
   * `useId()` 是**位置派生**的：进出分享模式时 `MessageList.tsx:99`/`:108` 的 label ↔ div
   * 互换会整体重挂，`:79` 的过滤还会改列表长度，实测同一个块拿到 `_R_0_` / `_R_2_` / `_R_2_`。
   * 于是「运行」按钮翻回未运行态，再点一下就用新 id 顶掉旧 run → iframe 重挂、demo 归零。
   * 改用 messageId + 代码块序号（内容推出来的，与渲染位置无关）之后这条必须稳。
   */
  it('点分享进入选择模式、再按 Esc 退出，按钮仍是「停止」，iframe 没换', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })
    const iframe = container.querySelector('iframe')!
    const token = tokenOf(iframe)
    expect(container.querySelector('.code-run')!.textContent).toBe('停止')

    // 进分享模式
    act(() => { fireEvent.click(container.querySelector('.msg-share')!) })
    expect(container.querySelector('.share-bar')).not.toBeNull()
    expect(container.querySelector('.code-run')!.textContent).toBe('停止')
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(tokenOf(container.querySelector('iframe')!)).toBe(token)

    // 出分享模式
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(container.querySelector('.share-bar')).toBeNull()
    expect(container.querySelector('.code-run')!.textContent).toBe('停止')
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(tokenOf(container.querySelector('iframe')!)).toBe(token)
  })

  /**
   * 上一条只有一个代码块，序号恒为 0 —— 就算实现忘了跨 part 累加基数也照样绿。
   * 这条把代码块分散在**两个 text part** 里：非分享模式渲染成两个 `<Markdown>`，
   * 分享模式拼成一个。不累加 `blockBase` 的话第二个块在两条路下分别是 0 和 1，
   * 进分享模式立刻翻回「运行」。
   */
  it('代码块分散在多个 part 里时，序号也不能漂（跨 part 累加 blockBase）', async () => {
    const { container } = mount()
    seed([FENCE('a'), null, FENCE('b')]) // 中间那次工具调用把两个代码块切进两个 text part
    await waitFor(() => expect(container.querySelectorAll('.code-run')).toHaveLength(2))

    // 跑**第二个**块
    act(() => { fireEvent.click(container.querySelectorAll('.code-run')[1]!) })
    const labels = () => Array.from(container.querySelectorAll('.code-run')).map((b) => b.textContent)
    expect(labels()).toEqual(['运行', '停止'])

    act(() => { fireEvent.click(container.querySelector('.msg-share')!) })
    expect(labels()).toEqual(['运行', '停止'])  // ← 序号漂了这里会变成 ['停止','运行'] 或全「运行」
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(labels()).toEqual(['运行', '停止'])
  })
})

describe('右栏 —— 预览不再长在消息流里', () => {
  it('iframe 是 .rail 的后代，不是 .stream 的后代', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })
    const iframe = container.querySelector('iframe')!
    expect(container.querySelector('.rail')!.contains(iframe)).toBe(true)
    expect(container.querySelector('.stream')!.contains(iframe)).toBe(false)
  })

  /** 右栏没挂载时不该有 iframe，也就不会有编译（编译只发生在 PreviewFrame 里）。 */
  it('没开预览时整棵树里没有 iframe', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(container.querySelector('iframe')).toBeNull()
  })

  /**
   * `.preview` 搬走后 `styles.css` 里的 `.code-wrap:has(.preview)` 会**静默失效**
   * （样式不报错，只是不再命中），「运行中按钮常驻」的体验原样回归。改由 React 打类。
   */
  it('运行中给 .code-wrap 打上 .running（P1-6：CSS 常驻按钮的新钩子）', async () => {
    const { container } = mount()
    seed([FENCE('a')])
    await waitFor(() => expect(container.querySelector('.code-run')).not.toBeNull())
    expect(container.querySelector('.code-wrap.running')).toBeNull()
    act(() => { fireEvent.click(container.querySelector('.code-run')!) })
    expect(container.querySelector('.code-wrap.running')).not.toBeNull()
    act(() => { fireEvent.click(container.querySelector('.preview-close')!) })
    expect(container.querySelector('.code-wrap.running')).toBeNull()
  })
})
