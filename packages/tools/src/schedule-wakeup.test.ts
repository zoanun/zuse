import { describe, it, expect } from 'vitest'
import { createScheduleWakeupTool } from './schedule-wakeup.js'

const dummyCtx = { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } }

describe('ScheduleWakeupTool', () => {
  it('calls onSchedule with clamped delay and message', async () => {
    let calledWith: { delayMs: number; message: string } | null = null
    const tool = createScheduleWakeupTool({
      onSchedule: (delayMs, message) => { calledWith = { delayMs, message } },
    })

    const result = await tool.run({ delaySeconds: 30, message: '检查 CI' }, dummyCtx)

    expect(calledWith).toEqual({ delayMs: 30000, message: '检查 CI' })
    expect(result.output).toContain('30 秒')
    expect(result.output).toContain('检查 CI')
    expect(result.isError).toBeFalsy()
  })

  it('clamps delaySeconds to [1, 3600]', async () => {
    const calls: number[] = []
    const tool = createScheduleWakeupTool({
      onSchedule: (delayMs) => { calls.push(delayMs) },
    })

    await tool.run({ delaySeconds: 0, message: 'a' }, dummyCtx)
    await tool.run({ delaySeconds: -5, message: 'b' }, dummyCtx)
    await tool.run({ delaySeconds: 9999, message: 'c' }, dummyCtx)

    expect(calls).toEqual([1000, 1000, 3600000])
  })

  it('rounds fractional seconds', async () => {
    let delayMs = 0
    const tool = createScheduleWakeupTool({
      onSchedule: (d) => { delayMs = d },
    })

    await tool.run({ delaySeconds: 1.7, message: 'x' }, dummyCtx)
    expect(delayMs).toBe(2000)
  })

  it('returns error for missing delaySeconds', async () => {
    const tool = createScheduleWakeupTool({ onSchedule: () => {} })
    const result = await tool.run({ message: 'x' }, dummyCtx)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('delaySeconds')
  })

  it('returns error for missing message', async () => {
    const tool = createScheduleWakeupTool({ onSchedule: () => {} })
    const result = await tool.run({ delaySeconds: 10 }, dummyCtx)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('message')
  })

  it('returns error for empty message', async () => {
    const tool = createScheduleWakeupTool({ onSchedule: () => {} })
    const result = await tool.run({ delaySeconds: 10, message: '' }, dummyCtx)
    expect(result.isError).toBe(true)
  })
})
