import { describe, it, expect, afterEach } from 'vitest'
import { SANDBOX_TOKENS } from './PreviewFrame.js'
import { __resetActivePreview, closePreview, openPreview, useIsPreviewOpen } from './activePreview.js'
import { renderHook, act } from '@testing-library/react'

afterEach(() => __resetActivePreview())

describe('sandbox token 集 —— 防误改锁', () => {
  /**
   * 这**不是**安全测试。设计 §5 已经如实承认：allow-scripts + allow-same-origin 同开
   * 等于没有沙箱（guest 能摸到 parent.document、删掉自己的 sandbox 属性再 reload）。
   *
   * 它锁的是「这是有意选择」这件事本身。将来某次「安全加固」很可能顺手摘掉
   * allow-same-origin —— 那不会让预览变安全（BashTool 本来就能执行任意命令），
   * 只会静默炸掉一堆依赖同源的东西。注释拦不住手快的人，断言可以。
   */
  it('allow-scripts 与 allow-same-origin 必须同时存在', () => {
    expect(SANDBOX_TOKENS).toContain('allow-scripts')
    expect(SANDBOX_TOKENS).toContain('allow-same-origin')
  })

  it('不含 allow-top-navigation —— guest 不该能把整个页面导航走', () => {
    expect(SANDBOX_TOKENS).not.toContain('allow-top-navigation')
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
