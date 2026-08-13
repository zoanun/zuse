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
/**
 * 右栏正在跑的东西。**两种来源共用一个槽**：
 *
 * - `snippet`：聊天里的代码块（Python/Java），跑在临时目录 → 服务端给**片段档**
 * - `command`：项目里的一条命令（`pnpm dev`…），跑在会话 cwd → 服务端给**项目档**
 *
 * 共用一个槽是刻意的：第一版**不做在飞列表**。多槽会立刻撞上「切焦点 = 最后一个
 * 订阅者退订 = 片段档当场被杀」那个未决问题（步骤4 spec §8.5(b)），
 * 而单槽根本不产生它。推后是免费的。
 */
export type ActiveExec = ActiveExecBase & (
  | { source: 'snippet'; kind: ExecKind; code: string }
  /** `label` 是给人看的（脚本名，如 `dev`）；`command` 是真正要跑的那条。 */
  | { source: 'command'; command: string; label: string }
)

interface ActiveExecBase {
  /** 身份，跨挂载稳定。代码块用 `messageId#序号`，脚本用 `script:<名字>`。 */
  id: string
  /** 归属哪个会话：切会话时右栏要清场，否则会挂着上一个会话的东西（预览侧踩过）。 */
  sessionId: string
  /**
   * 跑完没有。**代码块上那个按钮的文案要靠它**。
   *
   * 真浏览器点一遍才发现的：只有「开着/没开」两态时，跑完之后按钮仍然写着「停止」，
   * 而点下去的实际行为是关掉面板 —— 文案和行为对不上，还让人以为进程还在跑。
   * 单测照不出来，因为没人问过「跑完之后按钮该写什么」。
   */
  done?: boolean
}

let active: ActiveExec | null = null
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

/**
 * 「跑的是不是同一件事」。
 *
 * 用途只有一个：重复 `openExec` 同一份东西时**不要 emit** —— 一次无意义的通知会让
 * 右栏白跑一轮，而右栏里挂着的是一条正在流的 SSE 连接，重挂等于**把在跑的进程掐了重来**。
 * 所以比的是「工作内容」，不是对象引用。
 */
function sameWork(a: ActiveExec, b: ActiveExec): boolean {
  if (a.source !== b.source) return false
  if (a.source === 'snippet' && b.source === 'snippet') return a.kind === b.kind && a.code === b.code
  if (a.source === 'command' && b.source === 'command') return a.command === b.command
  return false
}

export function openExec(next: ActiveExec): void {
  // 同一份重复打开就不 emit：一次无意义的通知会让右栏白跑一轮，
  // 而右栏里挂着的是一条正在流的 SSE 连接。
  if (active && active.id === next.id && active.sessionId === next.sessionId && sameWork(active, next)) return
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

/** 跑完了：右栏收到 end 之后调。只改标志，**不关面板** —— 输出得留着给人看。 */
export function markExecDone(id: string): void {
  if (!active || active.id !== id || active.done) return
  active = { ...active, done: true }
  emit()
}

/**
 * 代码块用的选择器：返回**三态字符串**（按值比较，安全）。
 *
 * 不是布尔：布尔只能表达「开着/没开」，而代码块按钮需要区分「正在跑」和「跑完了」——
 * 两态时跑完之后按钮仍写着「停止」，点下去却是关面板。真浏览器点一遍才发现的。
 */
export function useExecState(id: string): 'idle' | 'running' | 'done' {
  const get = (): 'idle' | 'running' | 'done' =>
    active?.id !== id ? 'idle' : active.done ? 'done' : 'running'
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
