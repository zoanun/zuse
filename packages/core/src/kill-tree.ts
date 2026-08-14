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
 * **硬杀**整棵进程树：POSIX 发 `SIGKILL` 而不是 `SIGTERM`。Windows 无差别
 *（`taskkill /F` 本来就是硬杀），保留这个入口只为让两边调用点写法一致。
 *
 * ## 存在理由：`killTree` 重发两次不构成「升级」
 *
 * `run.ts` 的 kill 宽限本来写着「宽限到点仍没 close → 升级再杀一次
 *（POSIX 的 SIGTERM 可能被忽略）」，而那一下调的还是 `killTree` = 同一个 SIGTERM。
 * 对 trap / ignore 掉 SIGTERM 的进程，重发 N 次与发 1 次完全等效。
 *
 * WSL Ubuntu 上用**本文件的产品代码**实测（不是等价脚本）：
 *
 *     spawned pid 5469 ALIVE
 *     killTree 第 1 次之后: ALIVE
 *     killTree 第 2 次之后: ALIVE   ← run.ts 两轮宽限的终点就在这里
 *     SIGKILL 之后:        DEAD(ESRCH)
 *
 * vite / webpack / nodemon 都 trap SIGTERM，所以这不是边角情况。
 *
 * ## 为什么是独立函数而不是 `killTree(pid, {hard})`
 *
 * 「谁在硬杀」应当是**可 grep 的事实**。可选布尔会让 `bash.ts` / `lsp/client.ts`
 * 那几个语义上也该硬杀的调用点静默保持软杀 —— 缺省值会替它们做决定。
 * 命名也与既有的 `killTreeSync` 成体系。
 *
 * 与 `killTreeSync` 的关系：那个（退出阶段用）本来就发 SIGKILL，
 * 等价于本函数的同步版。两处刻意保持一致，不要「统一」成 SIGTERM。
 */
export function killTreeHard(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') { killTree(pid); return }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已经死了 */ }
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
