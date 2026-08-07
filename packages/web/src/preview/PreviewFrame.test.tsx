import { describe, it, expect, afterEach } from 'vitest'
import { PreviewFrame, SANDBOX_TOKENS } from './PreviewFrame.js'
import { __resetActivePreview, closePreview, openPreview, useIsPreviewOpen } from './activePreview.js'
import { setTheme } from '../theme.js'
import type { HostMessage, PreviewSpec } from './types.js'
import { renderHook, act, render, cleanup } from '@testing-library/react'

afterEach(() => {
  __resetActivePreview()
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('sandbox token 集 —— 安全锁', () => {
  /**
   * **这条是真的安全测试，不是防误改测试**（它取代了初版那条「必须同时存在」的反向断言）。
   *
   * srcdoc 文档继承父页 origin。给了 allow-same-origin，预览里的代码就能直接
   * `fetch('/api/sessions')`、`PUT /api/files/content`、`POST /api/mcp`（注册任意
   * command 的 stdio server，下次 daemon 重启就执行），全部带着父页的认证 cookie，
   * 而且**一个权限提示都不弹** —— BashTool 那条路径有 canUseTool 弹框，这条 HTTP
   * 路径没有。真浏览器实测：/api/sessions 返回 200 + 真实会话数据。
   *
   * 所以「BashTool 本来就能执行任意命令，沙箱挡不住任何本来挡得住的东西」是错的：
   * 沙箱挡住的正是「绕过权限提示的无人值守提权」。加回来 = 把这个洞重新打开。
   */
  it('绝不能含 allow-same-origin —— 有它预览代码就能免权限提示打已认证 API', () => {
    expect(SANDBOX_TOKENS).not.toContain('allow-same-origin')
  })

  it('仍要有 allow-scripts —— 没有它预览根本跑不起来', () => {
    expect(SANDBOX_TOKENS).toContain('allow-scripts')
  })

  it('不含 allow-top-navigation —— guest 不该能把整个页面导航走', () => {
    expect(SANDBOX_TOKENS).not.toContain('allow-top-navigation')
  })
})

/**
 * jsdom 里 iframe 的 guest 脚本不会真跑，所以这里用一个假 contentWindow 顶替：
 * 收集父页 → guest 的 postMessage，并手工派发 guest → 父页的 'ready'。
 * token 从 srcdoc 里的 preamble 源码回读（`var TOKEN = "..."`），不猜。
 */
function harness(spec: PreviewSpec) {
  const sent: HostMessage[] = []
  const fakeWin = { postMessage: (m: HostMessage) => { sent.push(m) } }
  const view = render(<PreviewFrame spec={spec} onClose={() => {}} />)
  const iframe = view.container.querySelector('iframe')!
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin })
  const srcdoc = () => iframe.getAttribute('srcdoc') ?? ''
  const token = /var TOKEN = "([^"]+)"/.exec(srcdoc())![1]!
  const ready = (): void => {
    const ev = new MessageEvent('message', { data: { type: 'ready', token } })
    // source 在 MessageEvent 原型上是只读 getter；用自有属性遮蔽它。
    Object.defineProperty(ev, 'source', { value: fakeWin })
    act(() => { window.dispatchEvent(ev) })
  }
  return {
    view, iframe, sent, srcdoc, ready,
    evals: () => sent.filter((m) => m.type === 'eval') as Array<Extract<HostMessage, { type: 'eval' }>>,
    themes: () => sent.filter((m) => m.type === 'theme') as Array<Extract<HostMessage, { type: 'theme' }>>,
  }
}

/** 等编译防抖 + 懒加载 sucrase 的真实 promise 落地。 */
async function settle(ms = 400): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}

const JSX_A = `const a = 1\nexport default a`
const JSX_B = `const b = 2\nexport default b`

describe('PreviewFrame —— 产物必须送达 guest', () => {
  /**
   * **P0-1 的核心回归锁。**
   *
   * srcdoc 一变就是一个全新 document —— 它不知道上一轮 eval 过什么，只会重新发一次
   * ready。若父页不在 ready 上重放最近一次产物，现象是「预览框在、里面永久空白、
   * 控制台零报错」：初版就是这样，切一次主题即触发（真浏览器实测 guest body 为空、
   * `[data-preview-injected]` 元素数为 0）。
   *
   * 别把这条改成「只在编译完成时下发」—— 那正是坏掉的写法。
   */
  it('document 重建后（再次收到 ready）必须重放最近一次 eval，而不是等下一次编译', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    await settle()
    h.ready()
    expect(h.evals()).toHaveLength(1)
    expect(h.evals()[0]!.js).toContain('const a = 1')

    // 模拟 document 被重建：新 document 从零开始，只会再发一次 ready。
    h.ready()
    expect(h.evals()).toHaveLength(2)
    expect(h.evals()[1]!.js).toContain('const a = 1')
  })

  it('新 document 就绪时也要补发主题 —— guest 不继承父页的 data-theme', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    await settle()
    h.ready()
    expect(h.themes().at(-1)?.theme).toBe('light')
    await act(async () => { setTheme('dark') })
    h.ready()
    expect(h.themes().at(-1)?.theme).toBe('dark')
  })

  /**
   * 切主题**不该**重建 iframe document。初版把 theme 塞进了 srcdoc 的 useMemo 依赖，
   * 于是切一次主题 = 换一个 document = 丢掉 demo 的全部状态（计数器归零）。
   * 主题有独立的 postMessage 通道（preamble 收到后改 data-theme），srcdoc 不必掺和。
   */
  it('切主题不重建 document（srcdoc 不变），改走 theme 消息', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    await settle()
    h.ready()
    const before = h.srcdoc()
    await act(async () => { setTheme('dark') })
    expect(h.srcdoc()).toBe(before)
    expect(h.themes().at(-1)?.theme).toBe('dark')
    // document 没换 → 也不该有第二次 eval。
    expect(h.evals()).toHaveLength(1)
  })
})

describe('PreviewFrame —— 不该重跑的时候绝不重跑', () => {
  /**
   * **P1-1 的回归锁。**
   *
   * 调用方（Markdown.tsx 的 CodeBlock）每次渲染都新建 `spec={{ kind, code }}` 字面量。
   * 编译 effect 若依赖 `spec` 对象身份，一次无关重渲染就重编译、重下发 eval、
   * 并 `setEntries([])` 清空控制台 —— 真浏览器实测：点一下代码块的「复制」按钮，
   * demo 的计数器就从 3 归 0（useCopy 的 setCopied(true) 触发重渲染），1.5 秒后
   * setCopied(false) 再来一遍。
   *
   * 所以依赖必须是 `spec.kind` / `spec.code` 两个原始值。
   */
  it('内容不变的重渲染（新对象字面量）不得重新下发 eval', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    await settle()
    h.ready()
    expect(h.evals()).toHaveLength(1)

    // 同样的 kind/code，但是一个全新的对象 —— 正是 CodeBlock 每次渲染干的事。
    for (let i = 0; i < 3; i++) {
      h.view.rerender(<PreviewFrame spec={{ kind: 'jsx', code: JSX_A }} onClose={() => {}} />)
      await settle()
    }
    expect(h.evals()).toHaveLength(1)
  })

  it('内容真的变了才重新编译下发', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    await settle()
    h.ready()
    h.view.rerender(<PreviewFrame spec={{ kind: 'jsx', code: JSX_B }} onClose={() => {}} />)
    await settle()
    expect(h.evals()).toHaveLength(2)
    expect(h.evals()[1]!.js).toContain('const b = 2')
  })

  /**
   * 设计 §4 承诺了「编译加防抖」，初版完全没做。模型是逐 token 吐代码的，
   * 每个 delta 编译一次 = 白烧 CPU（Vue 那条路还要拖 374 KB 的 compiler-sfc）。
   */
  it('编译有防抖：连续改动只编译最后一次', async () => {
    const h = harness({ kind: 'jsx', code: JSX_A })
    h.ready()
    // 防抖窗口内连改，中间态一次都不该被编译下发。
    for (const code of ['const x = 1', 'const x = 12', 'const x = 123']) {
      h.view.rerender(<PreviewFrame spec={{ kind: 'jsx', code }} onClose={() => {}} />)
      await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    }
    await settle()
    expect(h.evals()).toHaveLength(1)
    expect(h.evals()[0]!.js).toContain('const x = 123')
  })
})

describe('全局单例：同一时刻只有一个预览是活的', () => {
  it('打开 B 会顶掉 A', () => {
    const a = renderHook(() => useIsPreviewOpen('A'))
    const b = renderHook(() => useIsPreviewOpen('B'))

    act(() => openPreview('A'))
    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(false)

    act(() => openPreview('B'))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(true)
  })

  it('关闭只认自己的 id —— 收起 A 不该顺手关掉正开着的 B', () => {
    const b = renderHook(() => useIsPreviewOpen('B'))
    act(() => openPreview('B'))
    act(() => closePreview('A'))
    expect(b.result.current).toBe(true)
    act(() => closePreview('B'))
    expect(b.result.current).toBe(false)
  })
})
