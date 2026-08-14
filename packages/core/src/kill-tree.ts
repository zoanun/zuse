import { spawn, spawnSync } from 'node:child_process'

/**
 * 杀掉整棵进程树。
 *
 * **为什么在 `@zuse/core` 而不是 `@zuse/tools`**：`tools` 依赖 `core`，所以 core 里的
 * MCP 传输层（`mcp-transport.ts`）引不到 tools 的实现。而它**必须**用这个 ——
 * `npx <server>` 在 Windows 上的真实后代树是 `cmd.exe → npx → node`，
 * `proc.kill()` 只打第一层。今天没留孤儿是因为 MCP server 恰好实现了 stdin EOF 自退，
 * 不是那段代码做对了。
 *
 * `tools/src/util.ts` 原样转出这两个函数，所有既有引入点不受影响 ——
 * **一份实现，不分叉**（`proc/index.ts` 的注释本来就在担心这件事）。
 */

/**
 * 异步杀树。child 是被 spawn 的进程，真正干活的命令可能是它的子进程；
 * 只 kill 父进程会留下占着管道的孙进程。Windows 用 taskkill /T 杀树，POSIX 杀进程组。
 *
 * **进程退出阶段不要用它** —— 见 `killTreeSync`。
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // **`'error'` 必须有监听者，否则一次 spawn 失败会打死整个 daemon。**
    //
    // `spawn()` 在启动失败时（PATH 里找不到 taskkill、权限不足…）**同步不抛**，
    // 而是异步 emit `'error'`；无监听者时 Node 直接 throw。而本函数的调用点全在
    // 定时器 / abort 回调里（`bash.ts` 的超时、`run.ts` 的 kill 宽限），那条栈上
    // **没有任何 catch**，本仓也没有 process 级 uncaughtException 兜底。
    // 于是后果是整机级：所有会话一起没。触发频率低，代价上限却是最高的那一档。
    //
    // 在调用点包 try/catch 是没用的 —— 它同步不抛，try/catch 接不住异步事件。
    // POSIX 分支一直有 try/catch，只有这一支裸奔。
    //
    // `stdio: 'ignore'` + `windowsHide`：不占管道、不闪黑框。
    const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    p.on('error', () => {
      // 杀不掉就杀不掉 —— 这里没有更好的补救，但绝不能把整个进程带走。
    })
  } else {
    try {
      process.kill(-pid, 'SIGTERM') // 负 pid = 整个进程组
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  }
}

/**
 * **同步**杀树 —— 只给 `process.on('exit')` 这一类「没有下一轮事件循环」的地方用。
 *
 * ## 为什么必须有它
 *
 * exit 阶段**定时器与 nextTick 都不会跑**，只有 microtask 跑。实测（本机 node v22）：
 *
 * ```
 * exit handler body ran
 * ASYNC_SPAWN            ← 碰巧打出来了（短命子进程 + 继承 stdio），不可依赖
 * SYNC_SPAWN
 * spawnSync status = 0
 * MICROTASK RAN
 * （TIMER RAN / NEXTTICK RAN 一个都没出现）
 * ```
 *
 * 而 `LspManager` 的退出兜底原来是 `process.once('exit', () => c.dispose())`，
 * 而 `dispose()` 真正的杀进程动作包在 `setTimeout(..., KILL_DELAY)` 里 ——
 * **那一刀永远不会落**。回溯审计在本机实测到 3 个残留的 tsserver。
 *
 * 同款先例：`tmux-isolation.ts` 用的就是 `spawnSync`。
 */
export function killTreeSync(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(-pid, 'SIGKILL') // 退出阶段没有第二次机会，直接 SIGKILL
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    // 退出路径上，杀不掉也只能认了 —— 但绝不能因此让退出本身失败。
  }
}
