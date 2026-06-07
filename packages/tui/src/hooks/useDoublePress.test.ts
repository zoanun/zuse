import { describe, it, expect } from 'vitest'
import { isWithinDoublePressWindow, DOUBLE_PRESS_WINDOW_MS } from './useDoublePress.js'

describe('isWithinDoublePressWindow', () => {
  it('从未按过（null）一律不算双击', () => {
    expect(isWithinDoublePressWindow(null, 1000)).toBe(false)
  })
  it('窗口内的第二次按下算双击', () => {
    expect(isWithinDoublePressWindow(1000, 1000 + DOUBLE_PRESS_WINDOW_MS - 1)).toBe(true)
    expect(isWithinDoublePressWindow(1000, 1000)).toBe(true) // 边界：间隔 0
    expect(isWithinDoublePressWindow(1000, 1000 + DOUBLE_PRESS_WINDOW_MS)).toBe(true) // 边界：恰好窗口
  })
  it('超过窗口不算双击', () => {
    expect(isWithinDoublePressWindow(1000, 1000 + DOUBLE_PRESS_WINDOW_MS + 1)).toBe(false)
  })
  it('支持自定义窗口', () => {
    expect(isWithinDoublePressWindow(1000, 1100, 50)).toBe(false)
    expect(isWithinDoublePressWindow(1000, 1040, 50)).toBe(true)
  })
})
