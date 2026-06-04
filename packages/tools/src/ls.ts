import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

interface LSInput {
  path?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Directory to list. Relative paths resolve against the working directory. Defaults to cwd.',
    },
  },
}

/**
 * LSTool —— 列出一个目录的直接子项，目录加 `/` 后缀以便区分。
 * 给模型一个"先看看这里有什么"的轻量入口（深层递归用 Glob）。
 */
export const LSTool: Tool = {
  name: 'LS',
  description:
    'List the entries of a directory (non-recursive). Directories are suffixed with "/". ' +
    'Use Glob for recursive file matching.',
  inputSchema,

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as LSInput
    const target = input.path ?? '.'
    const absPath = isAbsolute(target) ? target : resolve(ctx.cwd, target)

    let info
    try {
      info = await stat(absPath)
    } catch {
      return { output: `Path not found: ${target}`, isError: true }
    }
    if (!info.isDirectory()) {
      return { output: `Path is not a directory: ${target}`, isError: true }
    }

    const entries = await readdir(absPath, { withFileTypes: true })
    if (entries.length === 0) {
      return { output: `(empty directory: ${target})`, isError: false }
    }

    // 目录在前、文件在后，各自按名称排序，目录名带 `/` 后缀。
    const names = entries
      .map((e) => ({ name: e.isDirectory() ? `${e.name}/` : e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .map((e) => e.name)

    return { output: names.join('\n'), isError: false }
  },
}
