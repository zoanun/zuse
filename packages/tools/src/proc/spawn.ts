/**
 * 进程层 —— 起子进程。
 *
 * originally 从 `bash.ts` 原样抽出（纯提取重构）；此后 **stdin 一档不再是原样** ——
 * 见下面 `SpawnShellOptions.stdin` 的注释，那是一次刻意的行为修正，不是提取遗漏。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolvedShell } from './shell.js'

/**
 * 本模块起出来的子进程。
 *
 * 不用 `ChildProcessWithoutNullStreams`：那个类型把 `stdin` 也断言成非空，而默认档
 * （`stdin: 'ignore'`）下 `child.stdin` 运行期就是 `null` —— 用那个类型等于让编译器
 * 替一个必然为 null 的值背书。这里把三根管子分开写：out/err 恒为流，in 可空。
 */
export type ShellChildProcess = ChildProcess & {
  stdout: Readable
  stderr: Readable
  stdin: Writable | null
}

export interface SpawnShellOptions {
  /** 子进程的工作目录。 */
  cwd: string
  /**
   * 子进程环境。**省略即继承 `process.env`** —— 传 undefined 是 spawn 的原生语义，
   * 比逐字复制一份环境更省事也更不易出错（见 buildChildEnv）。
   */
  env?: NodeJS.ProcessEnv
  /**
   * 子进程的 stdin，默认 `'ignore'`。
   *
   * **默认必须是 ignore，别改回 pipe。** spawn 的原生默认是 `'pipe'`：给子进程接一根
   * 没人写、也没人关的管子。于是任何读 stdin 的命令（`more`、`sort`、`findstr`、
   * `set /p`、裸 `node`/`python`）都读不到 EOF，**永久挂起**。实测（本机 git-bash）：
   * `pipe` 下这些命令 3s 仍未退出，`ignore` 下 82–114ms 正常退出。
   *
   * Bash 工具那边有超时兜底，症状只是「白等一整个超时才报 timeout」；但 run 服务的
   * **项目档没有墙钟**（见 code-exec-runner-v4 §1 表），那里就是真的永久挂住一个进程。
   *
   * 需要往子进程喂输入时才显式传 `'pipe'`，此时 `child.stdin` 才非空。
   */
  stdin?: 'ignore' | 'pipe'
}

/**
 * 经选定的 shell 跑一条命令串。
 *
 * **必须走 shell**：不带 shell 时 Windows 上 `mvn`/`vite` 这类 `.cmd` 入口会 ENOENT，
 * 而 `spawn('mvn.cmd')` 是**同步 throw EINVAL**（不是 error 事件）—— daemon 会崩而不是报错。
 * 因此这里接受的是一条命令**字符串**，不是 exec+args 数组。
 *
 * POSIX 下 detached 让 child 成为进程组组长，killTree 才能用负 pid 杀整组。
 */
export function spawnShellCommand(
  command: string,
  opts: SpawnShellOptions,
): ShellChildProcess {
  return spawn(command, {
    cwd: opts.cwd,
    shell: resolvedShell(),
    detached: process.platform !== 'win32',
    // 只有 stdin 这一档可配；out/err 永远是 pipe —— 本项目起子进程就是为了收它们的输出。
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
    ...(opts.env ? { env: opts.env } : {}),
  }) as ShellChildProcess
}
