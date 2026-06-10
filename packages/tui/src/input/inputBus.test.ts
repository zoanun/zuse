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

describe('粘贴分流', () => {
  it('isPasted 事件投给粘贴订阅者(传内容),不触发按键订阅者', () => {
    const bus = createInputBus()
    const keys: string[] = []
    const pastes: string[] = []
    bus.subscribe({ current: { handler: (input) => keys.push(input), isActive: true } })
    bus.subscribePaste({ current: { handler: (content) => pastes.push(content), isActive: true } })
    // 构造一个粘贴 ParsedKey
    bus.dispatch({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false, shift: false,
      option: false, super: false, sequence: 'a\nb', raw: 'a\nb', isPasted: true,
    })
    expect(pastes).toEqual(['a\nb'])
    expect(keys).toEqual([])
  })

  it('普通按键不触发粘贴订阅者', () => {
    const bus = createInputBus()
    const pastes: string[] = []
    bus.subscribePaste({ current: { handler: (c) => pastes.push(c), isActive: true } })
    bus.dispatch(parseKeypress('a'))
    expect(pastes).toEqual([])
  })

  it('isActive=false 的粘贴订阅者不收', () => {
    const bus = createInputBus()
    const pastes: string[] = []
    bus.subscribePaste({ current: { handler: (c) => pastes.push(c), isActive: false } })
    bus.dispatch({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false, shift: false,
      option: false, super: false, sequence: 'x\ny', raw: 'x\ny', isPasted: true,
    })
    expect(pastes).toEqual([])
  })

  it('遍历期间退订粘贴订阅者:被退订者本次即不收', () => {
    const bus = createInputBus()
    const got: string[] = []
    let offB = (): void => {}
    const refA = { current: { handler: () => { got.push('A'); offB() }, isActive: true } }
    const refB = { current: { handler: () => { got.push('B') }, isActive: true } }
    bus.subscribePaste(refA)
    offB = bus.subscribePaste(refB)
    bus.dispatch({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false, shift: false,
      option: false, super: false, sequence: 'x', raw: 'x', isPasted: true,
    })
    expect(got).toEqual(['A'])
  })
})
