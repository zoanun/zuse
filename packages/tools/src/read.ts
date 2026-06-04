import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 一次 Read 返回行数的默认上限（让输出有界）。 */
const DEFAULT_LIMIT = 2000
/** 超过此长度的单行将被截断（避免吐出压缩成一行的大块内容）。 */
const MAX_LINE_LENGTH = 2000

interface ReadInput {
  file_path: string
  offset?: number
  limit?: number
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Path to the file to read. Relative paths resolve against the working directory.',
    },
    offset: {
      type: 'number',
      description: '1-based line number to start reading from. Optional.',
    },
    limit: {
      type: 'number',
      description: `Maximum number of lines to read. Defaults to ${DEFAULT_LIMIT}.`,
    },
  },
  required: ['file_path'],
}

/**
 * ReadTool —— 读取一个文本文件，并以 cat -n 风格的行号返回内容。
 * 仿照 Claude Code 的 FileReadTool。错误（文件不存在、是目录、空文件）
 * 以 ToolResult{ isError: true } 返回，好让模型被告知，而不是默默地被
 * 喂一个空字符串（故障模式④）。
 */
export const ReadTool: Tool = {
  name: 'Read',
  description:
    'Read a text file from the local filesystem. Returns the contents with line numbers ' +
    '(format: "<line>\\t<text>"). Use offset/limit to read a slice of a large file.',
  inputSchema,

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as ReadInput
    if (!input.file_path || typeof input.file_path !== 'string') {
      return { output: 'Read requires a file_path.', isError: true }
    }

    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    let info
    try {
      info = await stat(absPath)
    } catch {
      return { output: `File not found: ${input.file_path}`, isError: true }
    }
    if (info.isDirectory()) {
      return { output: `Path is a directory, not a file: ${input.file_path}`, isError: true }
    }

    const raw = await readFile(absPath, 'utf8')
    // 登记"读的是哪个版本"，供 read-before-edit 校验（Phase 4）。空文件也算读过。
    ctx.tracker.markRead(absPath, info.mtimeMs)
    if (raw === '') {
      return { output: `(file is empty: ${input.file_path})`, isError: false }
    }

    const allLines = raw.split('\n')
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const limit = input.limit ?? DEFAULT_LIMIT
    const slice = allLines.slice(start, start + limit)

    const numbered = slice
      .map((line, i) => {
        const lineNo = start + i + 1
        const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…[truncated]' : line
        return `${lineNo}\t${text}`
      })
      .join('\n')

    const truncatedNote =
      allLines.length > start + limit
        ? `\n\n[truncated: showing lines ${start + 1}-${start + slice.length} of ${allLines.length}]`
        : ''

    return { output: numbered + truncatedNote, isError: false }
  },
}
