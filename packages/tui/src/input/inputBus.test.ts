import { describe, it, expect } from 'vitest'
import { createInputBus } from './inputBus.js'
import { parseKeypress } from './parseKeypress.js'

describe('createInputBus', () => {
  it('广播给 isActive 的订阅者,跳过非 active', () => {
    const bus = createInputBus()
    const got: string[] = []
    const activeRef = { current: { handler: (input: string) => got.push('A:' + input), isActive: true } }
    const offRef = { current: { handler: (input: string) => got.push('B:' + input), isActive: false } }
    bus.subscribe(activeRef)
    bus.subscribe(offRef)

    bus.dispatch(parseKeypress('h'))
    expect(got).toEqual(['A:h'])
  })

  it('传递映射后的 key:方向键置 upArrow', () => {
    const bus = createInputBus()
    let seen: { input: string; up: boolean } | null = null
    bus.subscribe({
      current: {
        handler: (input, key) => {
          seen = { input, up: key.upArrow }
        },
        isActive: true,
      },
    })
    bus.dispatch(parseKeypress('\x1b[A'))
    expect(seen).toEqual({ input: '', up: true })
  })

  it('unsubscribe 后不再收到', () => {
    const bus = createInputBus()
    let count = 0
    const ref = { current: { handler: () => { count++ }, isActive: true } }
    const off = bus.subscribe(ref)
    bus.dispatch(parseKeypress('a'))
    off()
    bus.dispatch(parseKeypress('b'))
    expect(count).toBe(1)
  })

  it('遍历期间退订:被退订者本次 dispatch 即不再收到', () => {
    const bus = createInputBus()
    const got: string[] = []
    let offB = (): void => {}
    const refA = { current: { handler: () => { got.push('A'); offB() }, isActive: true } }
    const refB = { current: { handler: () => { got.push('B') }, isActive: true } }
    bus.subscribe(refA)
    offB = bus.subscribe(refB)
    bus.dispatch(parseKeypress('a'))
    expect(got).toEqual(['A'])
  })

  it('多个 active 订阅者都收到', () => {
    const bus = createInputBus()
    const got: string[] = []
    bus.subscribe({ current: { handler: () => got.push('A'), isActive: true } })
    bus.subscribe({ current: { handler: () => got.push('B'), isActive: true } })
    bus.dispatch(parseKeypress('x'))
    expect(got).toEqual(['A', 'B'])
  })

  it('dispatch 期间被置为 inactive 的订阅者本次即跳过', () => {
    const bus = createInputBus()
    const got: string[] = []
    const refB = { current: { handler: () => got.push('B'), isActive: true } }
    const refA = { current: { handler: () => { got.push('A'); refB.current.isActive = false }, isActive: true } }
    bus.subscribe(refA)
    bus.subscribe(refB)
    bus.dispatch(parseKeypress('y'))
    expect(got).toEqual(['A'])
  })
})
