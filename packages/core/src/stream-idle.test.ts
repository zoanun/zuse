import { describe, it, expect } from 'vitest'
import { StreamIdleGuard, resolveStreamIdleMs, DEFAULT_STREAM_IDLE_MS } from './stream-idle.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 每 stepMs 吐一个数字、共 count 个的活跃流（用于验证 tap 会重置空闲计时）。 */
async function* ticking(count: number, stepMs: number): AsyncIterable<number> {
  for (let i = 0; i < count; i++) {
    await sleep(stepMs)
    yield i
  }
}

describe('StreamIdleGuard', () => {
  it('空闲超过阈值即中断，并标记 timedOut', async () => {
    const g = new StreamIdleGuard(20)
    await sleep(60)
    expect(g.signal.aborted).toBe(true)
    expect(g.timedOut).toBe(true)
    g.dispose()
  })

  it('tap 每收到一个数据块就重置计时：持续有数据的慢流不会误判超时', async () => {
    // 阈值 150ms，每 20ms 来一个块（共 10 个，跨度 ~200ms > 150ms）：
    // 块间间隔始终 < 阈值，不应中断。
    //
    // 余量是刻意拉开的（7.5 倍，原先只有 2.7 倍）：全量并行跑时 worker 被饿死，
    // 一次 20ms 的 setTimeout 可能实际睡 50ms+。原参数下这会越过阈值造成误判 —— 实测
    // 全量跑时约 1/4 概率红。测试意图（总跨度必须大于阈值，才能证明计时器真的被重置了）
    // 靠加块数保住，不是靠缩短阈值。
    const g = new StreamIdleGuard(150)
    const got: number[] = []
    for await (const n of g.tap(ticking(10, 20))) got.push(n)
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(g.signal.aborted).toBe(false)
    expect(g.timedOut).toBe(false)
    g.dispose()
  })

  it('tap 透传完毕后，最后一次武装的计时器仍会在静默后触发（流虽尽但守卫只到 dispose 才停）', async () => {
    // 说明 dispose 的必要性：不 dispose，残留计时器会在阈值后 abort。
    const g = new StreamIdleGuard(30)
    for await (const _ of g.tap(ticking(1, 5))) void _
    expect(g.signal.aborted).toBe(false)
    await sleep(60)
    expect(g.signal.aborted).toBe(true) // 未 dispose → 残留计时器触发
    g.dispose()
  })

  it('dispose 后计时器不再触发', async () => {
    const g = new StreamIdleGuard(20)
    g.dispose()
    await sleep(60)
    expect(g.signal.aborted).toBe(false)
  })

  it('外部信号中断会传导到 guard.signal，且不算超时', () => {
    const ext = new AbortController()
    const g = new StreamIdleGuard(10_000, ext.signal)
    expect(g.signal.aborted).toBe(false)
    ext.abort()
    expect(g.signal.aborted).toBe(true)
    expect(g.timedOut).toBe(false)
    g.dispose()
  })

  it('外部信号在构造前已中断：guard.signal 立即处于中断态', () => {
    const ext = new AbortController()
    ext.abort()
    const g = new StreamIdleGuard(10_000, ext.signal)
    expect(g.signal.aborted).toBe(true)
    g.dispose()
  })
})

describe('resolveStreamIdleMs', () => {
  const KEY = 'ZUSE_STREAM_IDLE_MS'
  it('未设环境变量时回退默认值', () => {
    delete process.env[KEY]
    expect(resolveStreamIdleMs()).toBe(DEFAULT_STREAM_IDLE_MS)
  })
  it('读取合法正数', () => {
    process.env[KEY] = '5000'
    try {
      expect(resolveStreamIdleMs()).toBe(5000)
    } finally {
      delete process.env[KEY]
    }
  })
  it('非法/非正值回退默认', () => {
    for (const bad of ['0', '-3', 'abc', '']) {
      process.env[KEY] = bad
      expect(resolveStreamIdleMs()).toBe(DEFAULT_STREAM_IDLE_MS)
    }
    delete process.env[KEY]
  })
})
