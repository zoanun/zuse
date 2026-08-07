import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { __resetActivePreview, closeRun, openRun, useActiveRun, useIsRunOpen, type ActiveRun } from './activePreview.js'

afterEach(() => { __resetActivePreview(); cleanup() })

const runIn = (sessionId: string, id = 'm1#0'): ActiveRun => ({ id, kind: 'jsx', code: 'const a = 1', sessionId })

describe('activePreview —— run 归属会话（设计 §3.3 / P0-2）', () => {
  it('别的会话的 run 一律看不见 —— 右栏不该挂着上一个会话的代码', () => {
    const a = renderHook(() => useActiveRun('sess-a'))
    const b = renderHook(() => useActiveRun('sess-b'))
    act(() => openRun(runIn('sess-a')))
    expect(a.result.current?.id).toBe('m1#0')
    expect(b.result.current).toBeNull()
  })
})

describe('activePreview —— getSnapshot 的引用必须稳定（设计 §3.1）', () => {
  /**
   * 返回派生对象（`() => ({ open: ... })`）每次都是新引用，useSyncExternalStore 会判定
   * 「变了」→ 立刻再渲染 → 再拿一个新引用 → **无限重渲染**。所以只允许返回 store 持有的
   * 那个对象本身、null、或按值比较的布尔。
   */
  it('状态没变时连续读到的是同一个对象（=== ，不是深相等）', () => {
    act(() => openRun(runIn('sess-a')))
    const h = renderHook(() => useActiveRun('sess-a'))
    const first = h.result.current
    expect(first).not.toBeNull()
    h.rerender()
    h.rerender()
    expect(h.result.current).toBe(first)
  })

  it('重复 openRun 同一份载荷不产生新对象（也就不会白通知一轮）', () => {
    act(() => openRun(runIn('sess-a')))
    const h = renderHook(() => useActiveRun('sess-a'))
    const first = h.result.current
    act(() => openRun(runIn('sess-a')))
    expect(h.result.current).toBe(first)
  })

  it('useIsRunOpen 返回布尔，按值比较', () => {
    const h = renderHook(() => useIsRunOpen('m1#0'))
    expect(h.result.current).toBe(false)
    act(() => openRun(runIn('sess-a')))
    expect(h.result.current).toBe(true)
    act(() => closeRun('m1#0'))
    expect(h.result.current).toBe(false)
  })
})

describe('__resetActivePreview 只重置 state，不许清 listeners（设计 §9）', () => {
  /**
   * 右栏是**长驻订阅者**。若 `__resetActivePreview()` 里还留着 `listeners.clear()`，
   * afterEach 调它一次就把仍然挂着的订阅静默掐断 —— 之后 store 再变，组件不再重渲染，
   * 测试全绿而功能是死的（假绿）。订阅的生命周期归 React 的 subscribe 返回值管。
   */
  it('reset 之后仍然挂着的订阅者还能收到通知', () => {
    const h = renderHook(() => useActiveRun('sess-a'))
    act(() => openRun(runIn('sess-a')))
    expect(h.result.current).not.toBeNull()

    act(() => { __resetActivePreview() })
    expect(h.result.current).toBeNull() // reset 本身也要通知到

    act(() => openRun(runIn('sess-a', 'm2#0')))
    expect(h.result.current?.id).toBe('m2#0') // ← listeners 被清掉的话这里会是 null
  })
})
