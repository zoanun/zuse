import type { ShellChildProcess } from './spawn.js'

/**
 * 进程层 —— **子进程什么时候算收尾了**。
 *
 * ## 为什么不能只听 `'close'`（这是本模块存在的唯一理由）
 *
 * `'close'` = 「进程已退出 **且** 所有 stdio 管道都关了」。后半句由**所有持有写端的
 * 进程**决定，包括子进程 fork 出去、继承了同一根 stdout 管道的**孙进程**。
 * 于是 `node x.js & echo done` 这类命令：前台 shell 秒退，孙进程握着管道不放，
 * **`close` 永不到达**。
 *
 * 实测（本仓真实的 `spawnShellCommand`，git-bash）：
 *
 * ```
 * echo / 8MB 输出 / 两个管道同时灌满 / 慢消费者   exit→close Δ=0ms，exit 后 0 字节
 * 后台安静孙进程                                 close 直到孙进程自己死才到
 * 后台吵孙进程                                   6 秒无 close，且还在喂数据
 * ```
 *
 * 后果不是「白等一个超时」，是**永不返回** —— `bash.ts` 的超时定时器只置标志 +
 * `killTree`，`finish()` 只挂在 `close` 上；孙进程扛过 taskkill 就没人 resolve 了。
 * run 那侧则是永久停在 `running`，占死一个并发额度。
 *
 * ## 这套判据成立的前提：**消费者必须一直处在 flowing 模式**
 *
 * Δ=0 不是「子进程写完才能退、node 一直在读」（那个解释是错的）。真实机制是
 * **node 在 emit `'exit'` 之后**才强制 `resume()` 各条 stdio 把它们冲干净。实测：
 * spawn 之后不挂 `'data'` 的话，序是 `exit → data(1000B) → close`，
 * 100% 的输出在 exit 之后才到；一个监听都不挂时那些字节直接被丢掉。
 *
 * 所以 **`bash.ts` / `run.ts` 的 `data` 监听必须在 spawn 之后同步挂上，
 * 而且绝不能给这条流加 `pause()` / 背压** —— 加了就会让 `drainMs` 到点收尾时
 * **静默丢一截输出**，而这份文件里白纸黑字写着「exit 后 0 字节」，没人会怀疑到这里。
 */
export interface SettleResult {
  code: number | null
  signal: NodeJS.Signals | null
  /**
   * `true` = 是 `'close'` 把它收掉的（管道确实空了）；
   * `false` = `exit` 之后等满 `drainMs` 仍无 `close`，多半有孙进程握着管道。
   */
  drained: boolean
}

export interface SettleOptions {
  /**
   * `exit` 之后等 `close` 的宽限。**这个 grace 的代价为零**：正常命令的 `close`
   * 在 Δ=0ms 就到，计时器根本轮不到触发；它只影响「有孙进程握管道」那一种情况，
   * 而那种情况在修之前是**永不返回**。所以宁可给宽一点。
   *
   * **已知没有上界**：消费者若把事件循环堵住，这个计时器和 `close` 会一起被堵，
   * 250ms 会变成任意长。堵住的时候任何判据都不管用，但「秒回」的承诺在重负载下
   * 不成立 —— 写在这里免得下次有人拿它当硬保证。
   */
  drainMs: number
  /**
   * `'exit'` 事件里**同步**触发，早于 `cb`。
   *
   * **不给它就会新造一个 zombie 竞态。** `run.ts` 的 kill 兑现是
   * `kill → signal() → +3s 再 signal() → +3s → toZombie()`。若「进程死了」这件事
   * 也推迟到 `exit + drainMs` 才被知道，exit 落在 `[kill+5750ms, kill+6000ms)` 时
   * 第二个 grace 会先到 → 一条**已经正常退出**的 run 被记成 `zombie`，
   * 而 `isLive()` 把 zombie 算成活的 → **永久占一个并发额度**。
   * 那正是本模块要修的失效模式，从另一个门回来。
   */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * 收尾判据。`cb` 至多触发一次。
 *
 * **`'error'` 刻意不进来。** spawn 失败时两个调用方的处置不一样（`bash.ts` 回
 * 「Failed to spawn」文案，`run.ts` 当成 `exitCode: null` 的一次退出），塞进来只会
 * 让这里长出一个「调用方各自解释」的返回值。
 *
 * 注意 ENOENT 的真实形态（实测）：**`'exit'` 不触发，`'close'` 带 `code: -4058` 触发**。
 * 所以本 helper 必然会被调一次。调用方的 `'error'` 分支要**先注册**并自行保证幂等 ——
 * 今天它靠事件顺序侥幸成立，写下来才不会被下一次改动打破。
 */
export function onChildSettled(
  child: ShellChildProcess,
  opts: SettleOptions,
  cb: (r: SettleResult) => void,
): { cancel(): void } {
  let done = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }

  const settle = (code: number | null, signal: NodeJS.Signals | null, drained: boolean): void => {
    if (done) return
    done = true
    clear()
    if (!drained) stopCollecting(child)
    cb({ code, signal, drained })
  }

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal, true))

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    opts.onExit?.(code, signal)
    if (done || timer !== null) return
    timer = setTimeout(() => settle(code, signal, false), opts.drainMs)
  })

  return { cancel: clear }
}

/**
 * 停止收集，**但绝不 `destroy()`**。
 *
 * v1 的设计写的就是 destroy —— 实测那会让孙进程写 stdout 拿 EPIPE **自杀**：
 *
 * ```
 * 不 destroy（对照）:  4.5s 后孙进程心跳 51ms 前   ⇒ 活着
 * destroy 之后 3s:    孙进程心跳 2774ms 前        ⇒ 已停
 * ```
 *
 * 也就是说 `pnpm dev &` 这类只要打日志的后台进程，会在 exit+250ms 被静默杀掉，
 * 而用户看到的是「done」秒回 —— 成功报文 + 静默失效，本仓最痛恨的那一类。
 *
 * 摘掉 `data` 监听后 `resume()`：node 在 flowing 且无 `data` 监听时读完即丢。
 * 实测（孙进程 80KB/s 灌 6 秒）：内部缓冲恒 0B、RSS 增量 0.9MB、孙进程活着。
 *
 * **必须补一个空的 `'error'` 监听。** 流上没有 `'error'` 监听者时 node 直接 throw，
 * 而这里在定时器回调栈上、没有任何 catch，本仓也没有 process 级兜底 —— 整机级。
 * 同 `util.ts` 里 `killTree` 那条教训：**在调用点包 try/catch 是没用的，它同步不抛。**
 */
function stopCollecting(child: ShellChildProcess): void {
  for (const s of [child.stdout, child.stderr]) {
    if (!s) continue
    s.removeAllListeners('data')
    s.on('error', () => { /* 管道错误在这里已经无人关心，但没有监听者 node 会 throw */ })
    s.resume()
  }
}
