/**
 * 工具间共用的小工具函数。集中放置以免各工具各写一份、日后措辞/语义漂移。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 在 PATH 列出的目录里找一个可执行文件，返回首个命中的绝对路径。 */
export function findOnPath(exe: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, exe)
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * 杀掉整棵进程树。child 是被 spawn 的进程，真正干活的命令可能是它的子进程。
 * 只 kill 父进程会留下占着管道的孙进程。Windows 用 taskkill /T 杀树，POSIX 杀进程组。
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
  } else {
    try {
      process.kill(-pid, 'SIGTERM') // 负 pid = 整个进程组
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  }
}

/**
 * 把可选数值夹取为正整数：是数字且 > 0 时向下取整，否则回落到 fallback。
 * 多个工具的分页/上下文参数（head_limit、offset、before/after/context 等）共用这套夹取。
 */
export function clampPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? Math.floor(value) : fallback
}

/** 按数量选单/复数词，避免 "1 entries" 这类拼写散落各处。 */
export function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural
}
