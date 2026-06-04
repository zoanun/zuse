import { writeFile, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve, dirname } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

interface WriteInput {
  file_path: string
  content: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Path to the file to write. Relative paths resolve against the working directory.',
    },
    content: {
      type: 'string',
      description: 'The full content to write. Overwrites the file if it exists.',
    },
  },
  required: ['file_path', 'content'],
}

/**
 * WriteTool —— 整文件写入（全量覆盖），仿照 Claude Code 的 FileWriteTool。
 * 适用于新建文件或整体重写；改局部请用 Edit。父目录不存在会自动创建。
 * 写成功后登记进 tracker（写完即"已读最新版"），允许接着 Edit（Phase 4）。
 */
export const WriteTool: Tool = {
  name: 'Write',
  description:
    'Write content to a file on the local filesystem, overwriting it if it exists. ' +
    'Creates parent directories as needed. Use this to create new files or fully ' +
    'rewrite a file; use Edit to change part of an existing file.',
  inputSchema,

  // TODO Phase 5: 写入前做权限校验
  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as WriteInput
    if (!input.file_path || typeof input.file_path !== 'string') {
      return { output: 'Write requires a file_path.', isError: true }
    }
    if (typeof input.content !== 'string') {
      return { output: 'Write requires a string content.', isError: true }
    }

    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    // 路径已存在且是目录 -> 拒绝（不能把目录当文件写）。
    try {
      const info = await stat(absPath)
      if (info.isDirectory()) {
        return { output: `Path is a directory, not a file: ${input.file_path}`, isError: true }
      }
    } catch {
      // 不存在 —— 正常的新建场景，继续。
    }

    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, input.content, 'utf8')

    // 写后刷新 tracker：当前 mtime 即"已读版本"，让随后的 Edit 能通过校验。
    const info = await stat(absPath)
    ctx.tracker.markRead(absPath, info.mtimeMs)

    const bytes = Buffer.byteLength(input.content, 'utf8')
    return { output: `Wrote ${bytes} bytes to ${input.file_path}`, isError: false }
  },
}
