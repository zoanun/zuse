/**
 * 进程层 —— 起子进程。
 *
 * 从 `bash.ts` 原样抽出（纯提取重构，spawn 选项一字未改），见设计 §1。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolvedShell } from './shell.js'

export interface SpawnShellOptions {
  /** 子进程的工作目录。 */
  cwd: string
  /**
   * 子进程环境。**省略即继承 `process.env`** —— 传 undefined 是 spawn 的原生语义，
   * 比逐字复制一份环境更省事也更不易出错（见 buildChildEnv）。
   */
  env?: NodeJS.ProcessEnv
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
): ChildProcessWithoutNullStreams {
  return spawn(command, {
    cwd: opts.cwd,
    shell: resolvedShell(),
    detached: process.platform !== 'win32',
    ...(opts.env ? { env: opts.env } : {}),
  })
}
