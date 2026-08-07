import { useSyncExternalStore } from 'react'
import type { PreviewKind } from './types.js'

/**
 * 全局单例：同一时刻只有一个代码块的预览是活的（设计 §6.5）。
 *
 * 为什么不允许多个：每个活预览 = 一个 iframe + 一份懒加载编译器。允许 N 个等于允许
 * N 份编译器同时驻留、N 个 iframe 抢 CPU，而用户实际上一次只看一个。
 *
 * 做成模块级 store 而不是 context，是因为消费者（CodeBlock）在一棵被 memo 切开的树里，
 * 用 context 会迫使 Markdown 的 `components` 表随状态重建 —— 那正是它被 hoist 出来
 * 要避免的事（每个流式 delta 都重新处理一遍 markdown）。
 *
 * 右栏（PR1）之后 store 不再只存一个 id，而是携带**运行载荷**：预览已经不在代码块
 * 内部渲染了，右栏与消息树之间没有任何父子关系，只能靠这份载荷把 kind/code 送过去。
 */
export interface ActiveRun {
  /** 运行的身份。**必须跨挂载稳定**：见 Markdown.tsx 里 runId 的注释（不能用 useId）。 */
  id: string
  kind: PreviewKind
  /**
   * 代码**快照**，不是活推（设计 §3.2）。点「运行」那一刻冻结。
   * 活推会把流式抖动通过模块级 store 广播给每一个 CodeBlock 订阅者，反而制造重渲染风暴；
   * 而运行按钮在流式期本就禁用，点下去时代码必然已完整。
   */
  code: string
  /**
   * run 归属哪个会话（设计 §3.3 / P0-2）。
   *
   * 预览还长在 CodeBlock 里时不需要这个字段：切会话 → 消息树换掉 → 预览随之消失。
   * 搬进右栏后右栏由 store 驱动、与消息树无关，**没有任何人会替它清场** ——
   * 在会话 A 打开预览、切到会话 B，右栏会继续挂着 A 的代码。
   * `/clear`、revert、switchSession 走的是同一条路。
   */
  sessionId: string
}

let activeRun: ActiveRun | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function openRun(run: ActiveRun): void {
  // 同一份 run 重复打开就不 emit：否则一次无意义的通知会让右栏白跑一轮。
  if (activeRun
    && activeRun.id === run.id
    && activeRun.kind === run.kind
    && activeRun.code === run.code
    && activeRun.sessionId === run.sessionId) return
  activeRun = run
  emit()
}

/** 关闭。带 id 时只关自己那条（收起 A 不该顺手关掉正开着的 B）；不带 id 一律关。 */
export function closeRun(id?: string): void {
  if (activeRun === null) return
  if (id !== undefined && activeRun.id !== id) return
  activeRun = null
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * 右栏用的选择器：只认属于 `sessionId` 的 run。
 *
 * **getSnapshot 只允许返回 store 持有的那个对象本身或 null**（设计 §3.1）。返回派生对象
 * （`() => ({ open: ... })`）每次都是新引用 → useSyncExternalStore 判定「变了」→ 无限重渲染。
 * 下面这个闭包满足这条：命中就原样返回 `activeRun`，不命中返回 null，两者都是稳定引用。
 *
 * 为什么在选择器里比 sessionId、而不是只靠 Shell 的 `useEffect(closeRun, [sessionId])`：
 * effect 在渲染之后才跑，切会话那一帧右栏会先闪一下上一个会话的预览。这里比对是同步的，
 * 没有那一帧。（Shell 侧的 effect 仍然保留，负责真正把 store 清干净，避免旧 run 长期驻留。）
 */
export function useActiveRun(sessionId: string): ActiveRun | null {
  const get = (): ActiveRun | null => (activeRun && activeRun.sessionId === sessionId ? activeRun : null)
  return useSyncExternalStore(subscribe, get, get)
}

/** 代码块用的选择器：返回布尔（按值比较，安全）。 */
export function useIsRunOpen(id: string): boolean {
  const get = (): boolean => activeRun?.id === id
  return useSyncExternalStore(subscribe, get, get)
}

/**
 * 仅供测试重置模块级状态。
 *
 * **绝不能再 `listeners.clear()`**（设计 §9）：右栏是长驻订阅者，afterEach 里清掉监听表
 * 会把仍然挂着的订阅静默掐断 —— 之后 store 变了组件不再重渲染，测试全绿而功能是死的。
 * 订阅的生命周期归 React（subscribe 的返回值），这里只管 state。
 */
export function __resetActivePreview(): void {
  activeRun = null
  emit()
}
