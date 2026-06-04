import { readFile, writeFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

interface EditInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Path to the file to edit. Relative paths resolve against the working directory.',
    },
    old_string: {
      type: 'string',
      description:
        'The exact text to find and replace. Must be unique in the file unless replace_all is true; ' +
        'include enough surrounding context to make it unique.',
    },
    new_string: {
      type: 'string',
      description: 'The text to replace old_string with. Must differ from old_string.',
    },
    replace_all: {
      type: 'boolean',
      description: 'Replace every occurrence instead of requiring a unique match. Defaults to false.',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
}

/** 统计 needle 在 haystack 中出现的次数（不重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count++
    from = idx + needle.length
  }
  return count
}

/**
 * EditTool —— 在已存在文件里做精确串替换，仿照 Claude Code 的 FileEditTool。
 * 本期核心：read-before-edit 校验。执行前依次校验
 *  ① 必须先 Read 过该文件（否则模型的 old_string 是"猜"的，可能盲改）；
 *  ② 读取后文件未被外部改动（mtime 乐观锁，挡 TOCTOU）；
 *  ③ old_string 在文件中恰好出现一次（或 replace_all 时 ≥1 次）；
 * 任一不满足都以 isError 回喂，模型据此自行先 Read 再重试（故障模式④）。
 */
export const EditTool: Tool = {
  name: 'Edit',
  description:
    'Replace exact text in an existing file. The file must have been read first (read-before-edit). ' +
    'old_string must be unique unless replace_all is true. Use this for local changes; ' +
    'use Write to create or fully rewrite a file.',
  inputSchema,

  // TODO Phase 5: 写入前做权限校验
  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as EditInput
    if (!input.file_path || typeof input.file_path !== 'string') {
      return { output: 'Edit requires a file_path.', isError: true }
    }
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
      return { output: 'Edit requires string old_string and new_string.', isError: true }
    }
    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical; nothing to change.', isError: true }
    }

    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    // 校验①：必须先 Read 过。
    const readTime = ctx.tracker.getReadTime(absPath)
    if (readTime === undefined) {
      return {
        output: `File has not been read yet. Read ${input.file_path} before editing it.`,
        isError: true,
      }
    }

    let info
    try {
      info = await stat(absPath)
    } catch {
      return { output: `File not found: ${input.file_path}`, isError: true }
    }
    if (info.isDirectory()) {
      return { output: `Path is a directory, not a file: ${input.file_path}`, isError: true }
    }

    // 校验②：读取后文件未被外部改动（乐观锁）。
    if (info.mtimeMs !== readTime) {
      return {
        output: `File ${input.file_path} was modified since it was read. Read it again before editing.`,
        isError: true,
      }
    }

    const content = await readFile(absPath, 'utf8')
    const occurrences = countOccurrences(content, input.old_string)

    // 校验③：old_string 必须能定位。
    if (occurrences === 0) {
      return { output: `old_string not found in ${input.file_path}.`, isError: true }
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        output:
          `old_string is not unique in ${input.file_path} (found ${occurrences} times). ` +
          'Add more surrounding context to target a single occurrence, or set replace_all.',
        isError: true,
      }
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string)

    await writeFile(absPath, updated, 'utf8')

    // 写后刷新 tracker，使同一回合内的后续 Edit 仍能通过 mtime 校验。
    const after = await stat(absPath)
    ctx.tracker.markRead(absPath, after.mtimeMs)

    const replaced = input.replace_all ? occurrences : 1
    return { output: `Edited ${input.file_path} (${replaced} replacement(s)).`, isError: false }
  },
}
