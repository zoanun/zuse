import { useEffect, useRef } from 'react'
import { useInputBus } from './InputProvider.js'
import type { InkKey } from './parsedKeyToInkKey.js'
import type { KeySubscriber } from './inputBus.js'

export type { InkKey }

/**
 * 与 Ink `useInput((input, key) => void, { isActive })` 同签名的 shim。
 * isActive=false 时不收键;多个 useInput 并存时各自门控(对齐现有
 * SelectList/ModelSelect 的互斥逻辑)。
 *
 * 用 ref 持有最新 handler/isActive:订阅项在挂载时注册一次、卸载时退订,
 * 期间靠 ref 拿到每次渲染的最新闭包,无需因 handler 变化而反复重订阅。
 */
export function useInput(
  handler: (input: string, key: InkKey) => void,
  opts?: { isActive?: boolean },
): void {
  const bus = useInputBus()
  const isActive = opts?.isActive ?? true
  const ref = useRef<KeySubscriber>({ handler, isActive })
  ref.current.handler = handler
  ref.current.isActive = isActive
  useEffect(() => {
    return bus.subscribe(ref)
  }, [bus])
}
