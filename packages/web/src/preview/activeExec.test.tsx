import { describe, expect, it, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { __resetActiveExec, closeExec, openExec, useActiveExec, useIsExecOpen, type ActiveExec } from './activeExec.js'
import { __resetActivePreview, openRun, useActiveRun } from './activePreview.js'

afterEach(() => { act(() => { __resetActiveExec(); __resetActivePreview() }) })

const execIn = (sessionId: string, id = 'm1#0'): ActiveExec =>
  ({ id, kind: 'python', code: 'print(1)', sessionId })

describe('activeExec', () => {
  it('只认属于本会话的：切到别的会话就看不见了', () => {
    const h = renderHook(() => useActiveExec('sess-a'))
    act(() => openExec(execIn('sess-a')))
    expect(h.result.current?.code).toBe('print(1)')
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

  it('useIsExecOpen 返回布尔', () => {
    const h = renderHook(() => useIsExecOpen('m1#0'))
    expect(h.result.current).toBe(false)
    act(() => openExec(execIn('sess-a')))
    expect(h.result.current).toBe(true)
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
    act(() => openExec({ id: 'e1', kind: 'python', code: 'print(1)', sessionId: 's' }))
    expect(prev.result.current).not.toBeNull()
    expect(exec.result.current).not.toBeNull()
  })

  it('反过来也一样：开 preview 不会关掉正跑着的 exec', () => {
    const prev = renderHook(() => useActiveRun('s'))
    const exec = renderHook(() => useActiveExec('s'))
    act(() => openExec({ id: 'e1', kind: 'python', code: 'print(1)', sessionId: 's' }))
    act(() => openRun({ id: 'p1', kind: 'html', code: '<b>x</b>', sessionId: 's' }))
    expect(exec.result.current).not.toBeNull()
    expect(prev.result.current).not.toBeNull()
  })
})
