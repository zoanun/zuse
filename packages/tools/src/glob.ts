import { glob } from 'node:fs/promises'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 一次 Glob 返回（展示）的路径条数上限（让输出有界）。 */
const MAX_RESULTS = 100
/** 枚举阶段的硬上限：避免在超大目录树上无限收集，同时给排序留足候选。 */
const HARD_CAP = 10_000

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

/**
 * GlobTool —— 按文件名/路径匹配查找文件（"在哪儿"），基于 Node 22 内置的
 * fs.glob，零依赖。只看路径不看内容；按内容找用 Grep。结果上限 MAX_RESULTS。
 */
export const GlobTool: Tool = {
  name: 'Glob',
  description:
    'Find files by path/name using a glob pattern (e.g. "**/*.ts"). Returns matching file paths. ' +
    'Use Grep to search file contents instead.',
  inputSchema,

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GlobInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return { output: 'Glob requires a pattern.', isError: true }
    }

    const base = input.cwd ? resolvePath(ctx.cwd, input.cwd) : ctx.cwd

    // 先收集（到 HARD_CAP 为止）再排序再截断：fs.glob 的产出是文件系统顺序，
    // 若边收边按 MAX_RESULTS 截断，再排序，得到的只是"任意一批里的前 N 个"，
    // 字母序靠前却恰好排在磁盘后面的文件会被漏掉、且结果随文件系统而变。
    const matches: string[] = []
    try {
      for await (const entry of glob(input.pattern, { cwd: base })) {
        matches.push(entry)
        if (matches.length >= HARD_CAP) break
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Glob failed: ${message}`, isError: true }
    }

    if (matches.length === 0) {
      return { output: `No files match: ${input.pattern}`, isError: false }
    }

    matches.sort()
    const truncated = matches.length > MAX_RESULTS
    const shown = truncated ? matches.slice(0, MAX_RESULTS) : matches
    const note = truncated
      ? `\n\n[truncated: showing first ${MAX_RESULTS} of ${matches.length} matches]`
      : ''
    return { output: shown.join('\n') + note, isError: false }
  },
}
