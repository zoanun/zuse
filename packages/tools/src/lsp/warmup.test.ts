import { describe, it, expect } from 'vitest'
import { queryWithWarmup, queryWithWarmupGrow } from './warmup.js'

// 不真睡的假 sleep:只记录被请求的时长。
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return { sleep: async (ms: number) => { waits.push(ms) }, waits }
}

describe('queryWithWarmup', () => {
  it('returns the first non-empty result without sleeping and marks warmed', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: false }
    let calls = 0
    const r = await queryWithWarmup(async () => { calls++; return [1] }, state, [10, 20], sleep)
    expect(r).toEqual([1])
    expect(calls).toBe(1)
    expect(waits).toEqual([])
    expect(state.warmed).toBe(true)
  })

  it('retries on empty (cold start) until results arrive, backing off per delays', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: false }
    const seq = [[], [], [42]] as number[][]
    let i = 0
    const r = await queryWithWarmup(async () => seq[i++]!, state, [10, 20, 30], sleep)
    expect(r).toEqual([42])
    expect(waits).toEqual([10, 20]) // 两次空 → 睡了两段后第三次命中
    expect(state.warmed).toBe(true)
  })

  it('does NOT retry an empty result once already warmed', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: true }
    let calls = 0
    const r = await queryWithWarmup(async () => { calls++; return [] }, state, [10, 20], sleep)
    expect(r).toEqual([])
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it('exhausts the delay budget and returns empty if always empty (still cold)', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: false }
    let calls = 0
    const r = await queryWithWarmup(async () => { calls++; return [] }, state, [10, 20], sleep)
    expect(r).toEqual([])
    expect(calls).toBe(3) // 初次 + 两次重试
    expect(waits).toEqual([10, 20])
    expect(state.warmed).toBe(false)
  })

  it('stops retrying when aborted', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: false }
    let calls = 0
    const r = await queryWithWarmup(async () => { calls++; return [] }, state, [10, 20], sleep, () => true)
    expect(r).toEqual([])
    expect(calls).toBe(1) // 首次空后即因 aborted 停手
    expect(waits).toEqual([])
  })
})

describe('queryWithWarmupGrow', () => {
  it('runs the whole budget while cold and returns the LARGEST result seen', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: false }
    // references grows as the project loads: declaration only → … → full set.
    const seq = [[1], [1], [1, 2, 3], [1, 2, 3]] as number[][]
    let i = 0
    const r = await queryWithWarmupGrow(async () => seq[i++]!, state, [10, 20, 30], sleep)
    expect(r).toEqual([1, 2, 3])
    expect(waits).toEqual([10, 20, 30]) // full budget — can't trust the partial early result
    expect(state.warmed).toBe(true)
  })

  it('issues a single query once warmed (project already loaded)', async () => {
    const { sleep, waits } = fakeSleep()
    const state = { warmed: true }
    let calls = 0
    const r = await queryWithWarmupGrow(async () => { calls++; return [1, 2] }, state, [10, 20], sleep)
    expect(r).toEqual([1, 2])
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it('aborts mid-warmup, returning the best so far WITHOUT marking warmed', async () => {
    const { sleep } = fakeSleep()
    const state = { warmed: false }
    let calls = 0
    const r = await queryWithWarmupGrow(async () => { calls++; return [1] }, state, [10, 20], sleep, () => true)
    expect(r).toEqual([1])
    expect(calls).toBe(1)          // aborted before the first retry
    expect(state.warmed).toBe(false) // not warmed → a later call will retry
  })
})
