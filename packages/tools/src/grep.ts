import { glob, readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve, relative } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 命中行数上限（让输出有界）。 */
const MAX_MATCHES = 200
/** 单行展示的字符上限。 */
const MAX_LINE_LENGTH = 500

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Regular expression to search for in file contents.',
    },
    path: {
      type: 'string',
      description: 'Directory to search under. Relative paths resolve against the working directory. Defaults to cwd.',
    },
    glob: {
      type: 'string',
      description: 'Optional glob to narrow which files are scanned, e.g. "**/*.ts". Defaults to all files.',
    },
  },
  required: ['pattern'],
}

/**
 * GrepTool —— 按文件内容搜索（"是什么"），手搓:用 fs.glob 枚举候选文件，
 * 逐行跑正则，命中输出 `相对路径:行号:命中行`。无 ripgrep 依赖，慢于 rg
 * 但正确可控。按文件名找文件用 Glob。命中数与行长都设上限。
 */
export const GrepTool: Tool = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression. Returns matches as "path:line:text". ' +
    'Use the glob option to narrow which files are scanned. Use Glob to find files by name instead.',
  inputSchema,

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GrepInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return { output: 'Grep requires a pattern.', isError: true }
    }

    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Invalid regular expression: ${message}`, isError: true }
    }

    const base = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd

    const filePattern = input.glob ?? '**/*'
    const lines: string[] = []
    let count = 0
    let truncated = false

    try {
      outer: for await (const entry of glob(filePattern, { cwd: base })) {
        const absPath = resolve(base, entry)
        // 只扫普通文件，跳过目录与读不动的项。
        let info
        try {
          info = await stat(absPath)
        } catch {
          continue
        }
        if (!info.isFile()) continue

        let content: string
        try {
          content = await readFile(absPath, 'utf8')
        } catch {
          continue // 二进制/无权限等 —— 跳过
        }

        const rel = relative(ctx.cwd, absPath)
        const fileLines = content.split('\n')
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i] ?? ''
          if (!regex.test(line)) continue
          if (count >= MAX_MATCHES) {
            truncated = true
            break outer
          }
          const text =
            line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…[truncated]' : line
          lines.push(`${rel}:${i + 1}:${text}`)
          count++
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Grep failed: ${message}`, isError: true }
    }

    if (lines.length === 0) {
      return { output: `No matches for: ${input.pattern}`, isError: false }
    }

    const note = truncated ? `\n\n[truncated: showing first ${MAX_MATCHES} matches]` : ''
    return { output: lines.join('\n') + note, isError: false }
  },
}
