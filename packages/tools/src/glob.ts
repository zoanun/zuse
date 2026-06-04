import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep, matchesGlob } from 'node:path'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 一次 Glob 返回（展示）的路径条数上限（让输出有界）。 */
const MAX_RESULTS = 100
/** 收集阶段的硬上限：避免在超大目录树上无限收集，同时给 mtime 排序留足候选。 */
const HARD_CAP = 10_000
/**
 * 遍历时直接剪枝、不下钻的目录：这两个几乎必然巨大、又几乎不会想用通配符去翻。
 * 与 CC 的取舍说明：CC 的 Glob 默认连 gitignore 都不应用（包含被忽略的文件），
 * 但我们这里既要能找到 `.env`/`.gitignore` 这类常被 gitignore 掉的隐藏文件
 * （所以不能套 gitignore），又不想每次 Glob 都去走一遍 node_modules/.git —— 折中
 * 就是只硬剪这两个目录。其余隐藏文件/目录照常包含，故对 `.env` 这类隐藏文件能命中。
 */
const PRUNED_DIRS = new Set(['.git', 'node_modules'])

interface GlobInput {
  pattern: string
  cwd?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Glob pattern, e.g. "**/*.ts" or "src/**/test-*.tsx".',
    },
    cwd: {
      type: 'string',
      description:
        'Directory to search from. Relative paths resolve against the working directory. Defaults to cwd.',
    },
  },
  required: ['pattern'],
}

interface GlobMatch {
  rel: string
  mtimeMs: number
}

/**
 * 从 dir 递归收集匹配 pattern 的文件（路径相对 base、统一用 '/' 分隔后再匹配，
 * 以兼容 Windows 的 '\\'）。隐藏文件一并纳入（修掉 fs.glob 的 dotfile 全盲），
 * 但不下钻 PRUNED_DIRS。每个命中文件 stat 一次拿 mtime 供排序；达到 HARD_CAP 即止。
 */
async function collect(
  base: string,
  dir: string,
  pattern: string,
  matches: GlobMatch[],
  signal: AbortSignal,
): Promise<void> {
  if (matches.length >= HARD_CAP) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 无权限/不可读：跳过该目录
  }
  for (const entry of entries) {
    if (signal.aborted) throw new Error('Glob aborted')
    if (matches.length >= HARD_CAP) return
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (PRUNED_DIRS.has(entry.name)) continue
      await collect(base, abs, pattern, matches, signal)
    } else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join('/')
      if (matchesGlob(rel, pattern)) {
        try {
          const info = await stat(abs)
          matches.push({ rel, mtimeMs: info.mtimeMs })
        } catch {
          // stat 失败（竞态删除等）：跳过
        }
      }
    }
    // 软链接（既非目录也非普通文件的 dirent）跳过，避免成环。
  }
}

/**
 * GlobTool —— 按文件名/路径匹配查找文件（"在哪儿"）。与 Claude Code 一致，这是个
 * 内部实现的工具（CC 的 Glob 也非 ripgrep 后端，无现成 OSS 二进制可换）：自写
 * readdir 递归遍历 + Node 22 内置的 `path.matchesGlob` 做匹配，零依赖。
 *
 * 对齐要点：结果按**修改时间倒序**（最近改的在前，跟 CC 一致），不是字母序；隐藏
 * 文件一并包含（CC 的 Glob 默认也含 gitignore 掉的文件）。只看路径不看内容，按
 * 内容找用 Grep。展示上限 MAX_RESULTS。
 */
export const GlobTool: Tool = {
  name: 'Glob',
  description:
    'Find files by path/name using a glob pattern (e.g. "**/*.ts"). Returns matching file paths ' +
    'sorted by modification time (most recent first). Use Grep to search file contents instead.',
  inputSchema,

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GlobInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return { output: 'Glob requires a pattern.', isError: true }
    }

    const base = input.cwd ? resolvePath(ctx.cwd, input.cwd) : ctx.cwd

    const matches: GlobMatch[] = []
    try {
      await collect(base, base, input.pattern, matches, ctx.signal)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Glob failed: ${message}`, isError: true }
    }

    if (matches.length === 0) {
      return { output: `No files match: ${input.pattern}`, isError: false }
    }

    // 按 mtime 倒序：最近修改的排在前面（与 CC 的 Glob 一致）。
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const truncated = matches.length > MAX_RESULTS
    const shown = truncated ? matches.slice(0, MAX_RESULTS) : matches
    const note = truncated
      ? `\n\n[truncated: showing first ${MAX_RESULTS} of ${matches.length} matches]`
      : ''
    return { output: shown.map((m) => m.rel).join('\n') + note, isError: false }
  },
}
