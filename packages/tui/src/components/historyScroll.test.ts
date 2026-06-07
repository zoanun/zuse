import { describe, it, expect } from 'vitest'
import { estimateMessageRows, computeHistoryWindow, clampOffsetRows } from './historyScroll.js'
import type { UIMessage } from '../types.js'

const user = (text: string): UIMessage => ({ id: 'u', role: 'user', text, isStreaming: false })
const assistant = (text: string, isStreaming = false): UIMessage => ({ id: 'a', role: 'assistant', text, isStreaming })
const system = (text: string): UIMessage => ({ id: 's', role: 'system', text, isStreaming: false })
const tool = (status: 'running' | 'done', output?: string): UIMessage => ({
  id: 't',
  role: 'tool',
  text: '',
  isStreaming: status === 'running',
  tool: { name: 'Read', input: {}, status, output },
})

describe('estimateMessageRows', () => {
  it('user 单行：边框上下 2 + 文本 1 + 下边距 1 = 4', () => {
    expect(estimateMessageRows(user('hi'), 80)).toBe(4)
  })
  it('assistant 纯工具回合（无文本非流式）占 0 行', () => {
    expect(estimateMessageRows(assistant(''), 80)).toBe(0)
  })
  it('assistant 流式空文本仍占行（spinner 气泡）', () => {
    expect(estimateMessageRows(assistant('', true), 80)).toBe(2) // 1 文本 + 1 下边距
  })
  it('工具块：running 占 2 行，done 带输出占 3 行', () => {
    expect(estimateMessageRows(tool('running'), 80)).toBe(2)
    expect(estimateMessageRows(tool('done', 'result'), 80)).toBe(3)
    expect(estimateMessageRows(tool('done'), 80)).toBe(2) // 无输出无预览
  })
  it('长行按列宽折行', () => {
    const longLine = 'x'.repeat(100)
    // system：折成 ceil(100/50)=2 行 + 下边距 1 = 3
    expect(estimateMessageRows(system(longLine), 50)).toBe(3)
  })
  it('硬换行逐段折行累加', () => {
    // 两段，每段 1 行 → system 2 + 下边距 1 = 3
    expect(estimateMessageRows(system('a\nb'), 80)).toBe(3)
  })
})

describe('computeHistoryWindow', () => {
  it('全部放得下：贴底显示全部，无裁剪', () => {
    const w = computeHistoryWindow([2, 2, 2], 10, 0)
    expect(w).toEqual({ start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0, maxOffsetRows: 0 })
  })

  it('溢出且贴底：只显示末尾，上方计数被裁条数', () => {
    // 总 20 行，视口 10。视口覆盖 [10,20)：msg2[10,15)、msg3[15,20) 可见；msg0、msg1 在上方。
    const w = computeHistoryWindow([5, 5, 5, 5], 10, 0)
    expect(w.start).toBe(2)
    expect(w.end).toBe(4)
    expect(w.hiddenAbove).toBe(2)
    expect(w.hiddenBelow).toBe(0)
    expect(w.maxOffsetRows).toBe(10)
  })

  it('上滚到顶：显示开头，下方计数被裁条数', () => {
    // off=10 → 视口覆盖 [0,10)：msg0、msg1 可见；msg2、msg3 在下方。
    const w = computeHistoryWindow([5, 5, 5, 5], 10, 10)
    expect(w.start).toBe(0)
    expect(w.end).toBe(2)
    expect(w.hiddenAbove).toBe(0)
    expect(w.hiddenBelow).toBe(2)
  })

  it('offset 超界自动夹到顶部', () => {
    const w = computeHistoryWindow([5, 5, 5, 5], 10, 999)
    expect(w.start).toBe(0)
    expect(w.end).toBe(2)
    expect(w.hiddenBelow).toBe(2)
  })

  it('空列表：空窗', () => {
    expect(computeHistoryWindow([], 10, 0)).toEqual({
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      maxOffsetRows: 0,
    })
  })

  it('零高消息不计入裁剪计数', () => {
    // msg1 为 0 高（纯工具回合）；总有效行 10，视口 4，贴底应裁掉上方有内容的消息但跳过 0 高。
    const w = computeHistoryWindow([5, 0, 5], 4, 0)
    // 视口覆盖 [6,10)：仅 msg2[5,10) 相交。msg0[0,5) 在上方算 1 条；msg1 零高不计。
    expect(w.hiddenAbove).toBe(1)
    expect(w.start).toBe(2)
    expect(w.end).toBe(3)
  })
})

describe('clampOffsetRows', () => {
  it('夹到 [0, max]', () => {
    expect(clampOffsetRows(-5, 10)).toBe(0)
    expect(clampOffsetRows(5, 10)).toBe(5)
    expect(clampOffsetRows(99, 10)).toBe(10)
    expect(clampOffsetRows(5, -1)).toBe(0)
  })
})
