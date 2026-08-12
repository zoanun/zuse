import { useSyncExternalStore } from 'react'
import type { ExecKind } from './types.js'

/**
 * 「正在真跑的那段代码」——与 `activePreview` **完全独立的第二个槽**（spec §3）。
 *
 * 为什么不是把 `ActiveRun` 改成判别联合塞进同一个槽：那等于**预览与执行互斥**。
 * 跑着的 Python 会被「打开一个 HTML 预览」挤掉，反过来也一样。两者本来就该能同时开着，
 * 它们在右栏是上下两块，不是一块地方的两种状态。
 *
 * 这个文件刻意和 `activePreview.ts` 长得很像但**不共用代码**：两者的字段将来会分岔
 * （执行侧要 runId、状态、输出，预览侧要 kind/code 快照），过早抽公共层只会让两边
 * 互相牵制。真到了三个槽再说。
 */
export interface ActiveExec {
  /** 代码块的身份，跨挂载稳定（同 `ActiveRun.id`）。 */
  id: string
  kind: ExecKind
  /** 点「运行」那一刻冻结的代码快照 —— 之后代码再变，跑的还是这一份。 */
  code: string
  /** 归属哪个会话：切会话时右栏要清场，否则会挂着上一个会话的东西（预览侧踩过）。 */
  sessionId: string
}

let active: ActiveExec | null = null
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

export function openExec(next: ActiveExec): void {
  // 同一份重复打开就不 emit：一次无意义的通知会让右栏白跑一轮，
  // 而右栏里挂着的是一条正在流的 SSE 连接。
  if (active
    && active.id === next.id
    && active.kind === next.kind
    && active.code === next.code
    && active.sessionId === next.sessionId) return
  active = next
  emit()
}

/** 关闭。带 id 时只关自己那条；不带 id 一律关（切会话用）。 */
export function closeExec(id?: string): void {
  if (active === null) return
  if (id !== undefined && active.id !== id) return
  active = null
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * 右栏用的选择器。
 *
 * **getSnapshot 只允许返回 store 持有的那个对象本身或 null**（预览侧那条注释同理）：
 * 返回派生对象每次都是新引用 → useSyncExternalStore 判定「变了」→ 无限重渲染。
 */
export function useActiveExec(sessionId: string): ActiveExec | null {
  const get = (): ActiveExec | null => (active && active.sessionId === sessionId ? active : null)
  return useSyncExternalStore(subscribe, get, get)
}

/** 代码块用的选择器：返回布尔（按值比较，安全）。 */
export function useIsExecOpen(id: string): boolean {
  const get = (): boolean => active?.id === id
  return useSyncExternalStore(subscribe, get, get)
}

/**
 * 仅供测试重置。
 *
 * **绝不能 `listeners.clear()`**：右栏是长驻订阅者，afterEach 里清掉监听表会把仍然挂着的
 * 订阅静默掐断 —— 之后 store 变了组件不再重渲染，测试全绿而功能是死的。
 * （这条是预览侧真踩过的，见 `activePreview.ts` 的同名函数。）
 */
export function __resetActiveExec(): void {
  active = null
  emit()
}
