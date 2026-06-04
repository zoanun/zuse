import { glob } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 一次 Glob 返回的路径条数上限（让输出有界）。 */
const MAX_RESULTS = 100

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
      description: 'Directory to search from. Relative paths resolve against the working directory. Defaults to cwd.',
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

    const base = input.cwd
      ? isAbsolute(input.cwd)
        ? input.cwd
        : resolve(ctx.cwd, input.cwd)
      : ctx.cwd

    const matches: string[] = []
    try {
      for await (const entry of glob(input.pattern, { cwd: base })) {
        matches.push(entry)
        if (matches.length > MAX_RESULTS) break
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
    const note = truncated ? `\n\n[truncated: showing first ${MAX_RESULTS} matches]` : ''
    return { output: shown.join('\n') + note, isError: false }
  },
}
