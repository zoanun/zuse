import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 调试日志 —— dev 模式下自动落盘到 <仓库根>/logs/dev.log，无需任何环境变量。
 *
 * 为什么落文件而不是 console：TUI 用 ink 接管了 stdout，直接 console.log 会冲花界面。
 * 为什么只在 dev 开：默认零开销、不污染单测，正式运行（走 zuse bin）也不写盘。
 *
 * 判定 dev：`pnpm dev` 会把 npm_lifecycle_event 设为脚本名 'dev'，正式运行时没有。
 * 想强制开启或自定义路径：设 ZUSE_DEBUG=<路径>（或 ZUSE_DEBUG=1 用默认路径）即可覆盖。
 */

// 解析结果缓存：undefined=还没解析；null=未开启；string=目标文件路径。
let cachedPath: string | null | undefined
// 每个进程首次写入时打一行会话分隔，免得多次 dev 的日志糊在一起难分辨。
let wroteHeader = false

/** 从本模块位置回溯到仓库根：packages/core/src → packages/core → packages → 根。 */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function resolvePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const override = process.env.ZUSE_DEBUG
  if (override && override !== '1' && override !== 'true') {
    cachedPath = override
  } else if (override || process.env.npm_lifecycle_event === 'dev') {
    // ZUSE_DEBUG=1 显式开启，或处于 dev：都写到仓库内的 logs/dev.log。
    cachedPath = join(repoRoot(), 'logs', 'dev.log')
  } else {
    cachedPath = null
  }
  return cachedPath
}

/** 调试日志是否开启（调用方可据此跳过昂贵的数据组装）。 */
export function debugEnabled(): boolean {
  return resolvePath() !== null
}

/** 追加一条日志：时间戳 + 标签 + JSON 化的数据。落盘失败静默吞掉，绝不影响主流程。 */
export function debugLog(label: string, data: unknown): void {
  const path = resolvePath()
  if (!path) return
  try {
    if (!wroteHeader) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `\n===== session start ${new Date().toISOString()} =====\n`)
      wroteHeader = true
    }
    appendFileSync(path, `${new Date().toISOString()} [${label}] ${safeStringify(data)}\n`)
  } catch {
    // 调试日志失败不该拖垮真实会话，忽略。
  }
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
