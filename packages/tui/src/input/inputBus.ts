import type { ParsedKey } from './parseKeypress.js'
import { parsedKeyToInkKey, type InkKey } from './parsedKeyToInkKey.js'

export type KeyHandler = (input: string, key: InkKey) => void

/** 一个订阅项的当前状态。用 ref 包裹便于在不重订阅的前提下更新。 */
export interface KeySubscriber {
  handler: KeyHandler
  isActive: boolean
}

export interface InputBus {
  /** 注册订阅项(传 ref);返回退订函数。 */
  subscribe(ref: { current: KeySubscriber }): () => void
  /** 派发一个解析后的按键:映射成 InkKey,广播给所有 isActive 的订阅者。 */
  dispatch(parsed: ParsedKey): void
}

export function createInputBus(): InputBus {
  const subs = new Set<{ current: KeySubscriber }>()
  return {
    subscribe(ref): () => void {
      subs.add(ref)
      return () => {
        subs.delete(ref)
      }
    },
    dispatch(parsed): void {
      const { input, key } = parsedKeyToInkKey(parsed)
      // 先快照成数组再遍历:handler 内可能 subscribe/unsubscribe(如打开对话框),
      // 避免遍历时修改 Set。再加 subs.has 守卫:被某 handler 中途退订的订阅者,
      // 本次 dispatch 即不再收到(否则快照仍持有其引用)。
      for (const ref of [...subs]) {
        if (subs.has(ref) && ref.current.isActive) ref.current.handler(input, key)
      }
    },
  }
}
