import { killTreeSync } from './kill-tree.js'

/**
 * 进程级的子进程兜底收割（回溯审计 F P2 第一步）。
 *
 * ## 为什么需要它
 *
 * `bin.ts` 只挂了 SIGINT / SIGTERM，而本仓在三处写下过同一个空缺：
 * `kill-tree.ts` / `http/server.ts` / `run/run.ts` 的注释都说「本仓没有 process 级
 * uncaughtException 兜底」。`run.ts` 那段还记着一次**真跑复现过**的事故：
 * 一个 SSE 订阅者 throw 一次，整个 daemon（用户的所有会话）退出码 1 死掉 ——
 * 那种死法下，正在跑的子进程今天是**零清理**，全变孤儿。
 *
 * ## 为什么只挂 `'exit'`，不挂 `uncaughtException`
 *
 * 实测（node v22，本机，探针见 spec §二）：
 *
 *     throw:  EXIT_HANDLER_RAN code=1     ← 未捕获异常，'exit' 照跑
 *     reject: EXIT_HANDLER_RAN code=1     ← 未处理的 rejection，'exit' 照跑
 *     normal: EXIT_HANDLER_RAN code=0
 *     （sigterm 那一行没出现：探针没注册 SIGTERM 处理器，走了 node 默认终止）
 *
 * 所以一个 `'exit'` 监听器就覆盖了两条崩溃路径，**且一点语义都不改**。
 * 挂 `uncaughtException` 反而危险：node 默认的「打印堆栈 + 退出」要自己重新实现，
 * 写漏一点就变成「崩溃之后进程不退出」。
 *
 * **不覆盖**：`taskkill /F`（不带 `/T`）、断电、OOM killer —— 那些要 Job Object，
 * 是第二步的事，本模块不假装覆盖它们。
 */

/** 在册的子进程 pid。只放**还活着的**（注销时机见 untrackChild）。 */
const live = new Set<number>()
let armed = false
/** 已注册的 `'exit'` 监听器（留引用只为测试能摘掉它，见 __resetChildReaperForTest）。 */
let handler: (() => void) | null = null

/**
 * 登记一个刚起的子进程。**顺带懒注册退出兜底** —— 同 `LspManager.armCleanup()` 的先例：
 * 标记长在使用点上，新增 spawn 点时不登记就是漏在眼前。
 *
 * 藏在库里自动注册 `'exit'` 是安全的（**加一个 exit 监听器不改变进程怎么死**）；
 * 换成 `uncaughtException` 就绝不能这么干，那会改变语义。
 */
export function trackChild(pid: number | undefined): void {
  if (pid === undefined) return // spawn 失败时 pid 就是 undefined
  armChildReaper()
  live.add(pid)
}

/**
 * 注销。**必须在子进程 `'exit'` 时调，不是 `'close'`。**
 *
 * 一旦进程退出，它的 pid 就可能被系统回收给别人。留在册子里，退出时那一发
 * `taskkill /T /F` 就会**误杀无辜进程** —— 这正是 `bin.ts` 的注释否决
 * 「pid 落盘 + 启动时回收」的同一条理由。
 *
 * 代价：shell 已退出、但它起的后台孙进程还活着时，我们放弃那个孙进程。
 * 这不是妥协 —— 它**本来就已经不可达**：父进程一死进程树就断了，
 * 事后补跑 `/T` 只会得到 `process not found`。
 */
export function untrackChild(pid: number | undefined): void {
  if (pid === undefined) return
  live.delete(pid)
}

/** 收割所有在册子进程（连同它们的进程树），返回处理的条数。收割后册子清空。 */
export function reapTrackedChildren(): number {
  const pids = [...live]
  live.clear()
  for (const pid of pids) killTreeSync(pid)
  return pids.length
}

/** 幂等地注册退出兜底。由 `trackChild` 自动调用；也可显式调。 */
export function armChildReaper(): void {
  if (armed) return
  armed = true
  handler = (): void => {
    reapTrackedChildren()
  }
  process.on('exit', handler)
}

/** 仅供测试。 */
export function __trackedPidsForTest(): number[] {
  return [...live]
}

/**
 * 仅供测试：清空册子并摘掉监听器。
 * **必须把监听器也摘掉** —— 否则一个用例装过之后，后面测「幂等」的用例就再也
 * 装不上第二个，断言 `before + 1` 会随用例顺序时红时绿（假绿的经典来源）。
 */
export function __resetChildReaperForTest(): void {
  live.clear()
  if (handler !== null) process.off('exit', handler)
  handler = null
  armed = false
}
