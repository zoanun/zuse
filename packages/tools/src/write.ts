import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath, fingerprintContent } from '@zuse/core'
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
      description:
        'Path to the file to write. Relative paths resolve against the working directory.',
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
 *
 * 新建文件畅通无阻；但覆盖**已存在**的文件同样受 read-before-edit 乐观锁约束
 *（与 Edit 一致）：必须先 Read 过、且读后未被外部改动，否则拒绝。全量覆盖是最
 * 具破坏性的修改，若放它绕过乐观锁，整套"不盲改"的保证就有了大洞。
 * 写成功后登记进 tracker（写完即"已读最新版"），允许接着 Edit/再次 Write。
 */
export const WriteTool: Tool = {
  name: 'Write',
  description:
    'Write content to a file on the local filesystem, overwriting it if it exists. ' +
    'Creates parent directories as needed. Overwriting an existing file requires having ' +
    'read it first (read-before-edit). Use this to create new files or fully ' +
    'rewrite a file; use Edit to change part of an existing file.',
  inputSchema,
  specifierFor: (input: unknown): string | null => {
    // 返回文件路径作为限定符；无则 null。
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' ? p : null
  },

  // TODO Phase 5: 写入前做权限校验
  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as WriteInput
    if (!input.file_path || typeof input.file_path !== 'string') {
      return { output: 'Write requires a file_path.', isError: true }
    }
    if (typeof input.content !== 'string') {
      return { output: 'Write requires a string content.', isError: true }
    }

    const absPath = resolvePath(ctx.cwd, input.file_path)

    // 路径已存在 -> 走覆盖分支：先挡目录，再做 read-before-edit 校验。
    let exists = false
    try {
      const info = await stat(absPath)
      if (info.isDirectory()) {
        return { output: `Path is a directory, not a file: ${input.file_path}`, isError: true }
      }
      exists = true
    } catch {
      // 不存在 —— 正常的新建场景，跳过乐观锁校验。
    }

    if (exists) {
      const stored = ctx.tracker.getFingerprint(absPath)
      if (stored === undefined) {
        return {
          output: `File ${input.file_path} already exists and has not been read. Read it before overwriting it (or use Edit).`,
          isError: true,
        }
      }
      const current = fingerprintContent(await readFile(absPath, 'utf8'))
      if (current !== stored) {
        return {
          output: `File ${input.file_path} was modified since it was read. Read it again before overwriting.`,
          isError: true,
        }
      }
    }

    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, input.content, 'utf8')

    // 写后刷新 tracker：刚写下的内容即"已读版本"，让随后的 Edit/Write 能通过校验。
    ctx.tracker.markRead(absPath, fingerprintContent(input.content))

    const bytes = Buffer.byteLength(input.content, 'utf8')
    return { output: `Wrote ${bytes} bytes to ${input.file_path}`, isError: false }
  },
}

export const toolModule = { make: () => WriteTool } satisfies import('./tool-module.js').ToolModule
