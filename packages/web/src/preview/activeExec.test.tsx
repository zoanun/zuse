import { describe, expect, it, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { __resetActiveExec, closeExec, openExec, markExecDone, useActiveExec, useExecState, type ActiveExec } from './activeExec.js'
import { __resetActivePreview, openRun, useActiveRun } from './activePreview.js'

afterEach(() => { act(() => { __resetActiveExec(); __resetActivePreview() }) })

const execIn = (sessionId: string, id = 'm1#0'): ActiveExec =>
  ({ id, source: 'snippet', kind: 'python', code: 'print(1)', sessionId })

describe('activeExec', () => {
  it('只认属于本会话的：切到别的会话就看不见了', () => {
    const h = renderHook(() => useActiveExec('sess-a'))
    act(() => openExec(execIn('sess-a')))
    expect(h.result.current?.source === 'snippet' && h.result.current.code).toBe('print(1)')
    const other = renderHook(() => useActiveExec('sess-b'))
    expect(other.result.current).toBeNull()
  })

  it('closeExec 带 id 时只关自己那条', () => {
    const h = renderHook(() => useActiveExec('sess-a'))
    act(() => openExec(execIn('sess-a', 'm1#0')))
    act(() => closeExec('m2#0'))
    expect(h.result.current).not.toBeNull()
    act(() => closeExec('m1#0'))
    expect(h.result.current).toBeNull()
  })

  /**
   * **三态，不是布尔。** 真浏览器点一遍才发现的：只有「开着/没开」两态时，
   * 跑完之后代码块上的按钮仍写着「停止」，而点下去的实际行为是关掉面板 ——
   * 文案和行为对不上，还让人以为进程还在跑。
   */
  it('useExecState 三态：没开 / 正在跑 / 跑完了', () => {
    const h = renderHook(() => useExecState('m1#0'))
    expect(h.result.current).toBe('idle')
    act(() => openExec(execIn('sess-a')))
    expect(h.result.current).toBe('running')
    act(() => markExecDone('m1#0'))
    expect(h.result.current).toBe('done')
  })

  it('markExecDone 只改标志，**不关面板** —— 输出得留着给人看', () => {
    const h = renderHook(() => useActiveExec('sess-a'))
    act(() => openExec(execIn('sess-a')))
    act(() => markExecDone('m1#0'))
    expect(h.result.current).not.toBeNull()
    expect(h.result.current?.done).toBe(true)
  })

  it('markExecDone 认错 id 不生效（免得关掉/标记了别人那条）', () => {
    const h = renderHook(() => useExecState('m1#0'))
    act(() => openExec(execIn('sess-a')))
    act(() => markExecDone('m2#0'))
    expect(h.result.current).toBe('running')
  })
})

/**
 * **这一组是拆双槽的全部理由。**
 *
 * 拆之前只有一个槽，判别联合意味着「预览与执行互斥」：跑着 20 分钟的 Python，
 * 点一下别的 HTML 代码块的运行，进程就被卸载掉了。两者在右栏是上下两块，
 * 不是一块地方的两种状态。
 */
describe('两个槽互不挤占', () => {
  it('开一个 exec 不会关掉正开着的 preview', () => {
    const prev = renderHook(() => useActiveRun('s'))
    const exec = renderHook(() => useActiveExec('s'))
    act(() => openRun({ id: 'p1', kind: 'html', code: '<b>x</b>', sessionId: 's' }))
    act(() => openExec({ id: 'e1', source: 'snippet', kind: 'python', code: 'print(1)', sessionId: 's' }))
    expect(prev.result.current).not.toBeNull()
    expect(exec.result.current).not.toBeNull()
  })

  it('反过来也一样：开 preview 不会关掉正跑着的 exec', () => {
    const prev = renderHook(() => useActiveRun('s'))
    const exec = renderHook(() => useActiveExec('s'))
    act(() => openExec({ id: 'e1', source: 'snippet', kind: 'python', code: 'print(1)', sessionId: 's' }))
    act(() => openRun({ id: 'p1', kind: 'html', code: '<b>x</b>', sessionId: 's' }))
    expect(exec.result.current).not.toBeNull()
    expect(prev.result.current).not.toBeNull()
  })
})
