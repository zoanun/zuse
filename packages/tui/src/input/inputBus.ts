import type { ParsedKey } from './parseKeypress.js'
import { parsedKeyToInkKey, type InkKey } from './parsedKeyToInkKey.js'

export type KeyHandler = (input: string, key: InkKey) => void

/** 一个按键订阅项的当前状态。用 ref 包裹便于在不重订阅的前提下更新。 */
export interface KeySubscriber {
  handler: KeyHandler
  isActive: boolean
}

/** 粘贴事件处理器:接收聚合后的完整粘贴内容。 */
export type PasteHandler = (content: string) => void

/** 一个粘贴订阅项的当前状态。与 KeySubscriber 同款 ref 模型。 */
export interface PasteSubscriber {
  handler: PasteHandler
  isActive: boolean
}

export interface InputBus {
  /** 注册按键订阅项(传 ref);返回退订函数。 */
  subscribe(ref: { current: KeySubscriber }): () => void
  /** 注册粘贴订阅项(传 ref);返回退订函数。 */
  subscribePaste(ref: { current: PasteSubscriber }): () => void
  /** 派发一个解析后的按键:粘贴事件走粘贴通道,普通按键走按键通道。 */
  dispatch(parsed: ParsedKey): void
}

export function createInputBus(): InputBus {
  const subs = new Set<{ current: KeySubscriber }>()
  const pasteSubs = new Set<{ current: PasteSubscriber }>()
  return {
    subscribe(ref): () => void {
      subs.add(ref)
      return () => {
        subs.delete(ref)
      }
    },
    subscribePaste(ref): () => void {
      pasteSubs.add(ref)
      return () => {
        pasteSubs.delete(ref)
      }
    },
    dispatch(parsed): void {
      // 粘贴事件单独分流给粘贴订阅者(传原始内容),不进按键通道。
      if (parsed.isPasted) {
        const content = parsed.sequence ?? ''
        for (const ref of [...pasteSubs]) {
          if (pasteSubs.has(ref) && ref.current.isActive) ref.current.handler(content)
        }
        return
      }
      // 普通按键:先快照成数组再遍历(handler 内可能 subscribe/unsubscribe),
      // 再加 subs.has 守卫(被中途退订者本次即不再收到)。
      const { input, key } = parsedKeyToInkKey(parsed)
      for (const ref of [...subs]) {
        if (subs.has(ref) && ref.current.isActive) ref.current.handler(input, key)
      }
    },
  }
}
