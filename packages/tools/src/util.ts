/**
 * 工具间共用的小工具函数。集中放置以免各工具各写一份、日后措辞/语义漂移。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 在 PATH 列出的目录里找一个可执行文件，返回首个命中的绝对路径。
 * Windows 上按 PATHEXT 依次补扩展名再试（.COM/.EXE/.BAT/.CMD…）——npm 全局装的命令
 * 多是 .CMD 启动器，裸名 existsSync 找不到。不补这一层，「命令在不在」的判断在 Windows
 * 上会漏报（LSP 据此误判 server 没装、Bash 据此选 shell，都会出错）。
 */
export function findOnPath(exe: string): string | undefined {
  // 先试裸名（已带扩展名的如 git.exe 直接命中）；win32 再按 PATHEXT 逐个补扩展名。
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, exe + ext)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * 杀进程树 —— **实现搬到了 `@zuse/core`**，这里原样转出，所有既有引入点不受影响。
 *
 * 搬家的理由：`core` 的 MCP 传输层也需要它（`npx <server>` 在 Windows 上的真实后代树
 * 是 `cmd.exe → npx → node`，`proc.kill()` 只打第一层），而 `tools` 依赖 `core`，
 * 反向引不到。**一份实现，不分叉。**
 */
export { killTree, killTreeSync } from '@zuse/core'

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
