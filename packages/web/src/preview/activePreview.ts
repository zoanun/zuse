import { useSyncExternalStore } from 'react'

/**
 * 全局单例：同一时刻只有一个代码块的预览是活的（设计 §6.5）。
 *
 * 为什么不允许多个：每个活预览 = 一个 iframe + 一份懒加载编译器。允许 N 个等于允许
 * N 份编译器同时驻留、N 个 iframe 抢 CPU，而用户实际上一次只看一个。
 *
 * 做成模块级 store 而不是 context，是因为消费者（CodeBlock）在一棵被 memo 切开的树里，
 * 用 context 会迫使 Markdown 的 `components` 表随状态重建 —— 那正是它被 hoist 出来
 * 要避免的事（每个流式 delta 都重新处理一遍 markdown）。
 */
let activeId: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function openPreview(id: string): void {
  if (activeId === id) return
  activeId = id
  emit()
}

export function closePreview(id?: string): void {
  if (id !== undefined && activeId !== id) return
  if (activeId === null) return
  activeId = null
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

const getSnapshot = (): string | null => activeId

export function useIsPreviewOpen(id: string): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) === id
}

/** 仅供测试重置模块级状态。 */
export function __resetActivePreview(): void {
  activeId = null
  listeners.clear()
}
