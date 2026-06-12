import { readFile, stat } from 'node:fs/promises'
import { resolvePath, fingerprintContent } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 一次 Read 返回行数的默认上限（让输出有界）。 */
const DEFAULT_LIMIT = 2000
/** 超过此长度的单行将被截断（避免吐出压缩成一行的大块内容）。 */
const MAX_LINE_LENGTH = 2000
/**
 * 单次 Read 输出的字符上限（对齐 CC 的 ~25k token 上限：按约 4 字符/token 粗估）。
 * 行数上限挡不住"行少但每行很宽"的文件，这道字符上限给真正喂给模型的总文本兜底。
 * 触顶即在行边界处停下并提示用 offset 续读，而非把超大内容整段塞进上下文。
 */
const MAX_OUTPUT_CHARS = 100_000

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
      description:
        'Path to the file to read. Relative paths resolve against the working directory.',
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
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    // 返回文件路径作为限定符；无则 null。
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' ? p : null
  },

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as ReadInput
    if (!input.file_path || typeof input.file_path !== 'string') {
      return { output: 'Read requires a file_path.', isError: true }
    }

    const absPath = resolvePath(ctx.cwd, input.file_path)

    let info
    try {
      info = await stat(absPath)
    } catch {
      return {
        output: `File not found: ${input.file_path}. Check the path, or use Glob to locate the file.`,
        isError: true,
      }
    }
    if (info.isDirectory()) {
      return { output: `Path is a directory, not a file: ${input.file_path}`, isError: true }
    }

    let raw: string
    try {
      raw = await readFile(absPath, 'utf8')
    } catch (err) {
      // stat 过了但 readFile 失败(EACCES/EBUSY 等):不裸抛给 agent 兜底层,
      // 在这里变成带指引的 observation(错误回传契约,Phase 8)。
      const msg = err instanceof Error ? err.message : String(err)
      return {
        output: `Failed to read ${input.file_path}: ${msg}. Check file permissions, or inspect it with Bash.`,
        isError: true,
      }
    }
    // 二进制检测:UTF-8 文本不含 NUL,含 NUL 即判二进制。乱码喂给模型毫无信号,
    // 拒读并指引换 Bash 检查;也不 markRead(读到的不是真内容,不给 Edit 通行证)。
    if (raw.includes('\0')) {
      return {
        output: `${input.file_path} appears to be a binary file; Read only supports text. Use Bash (e.g. \`file\`) to inspect it.`,
        isError: true,
      }
    }
    // 登记"读的是哪个版本"（内容指纹），供 read-before-edit 校验（Phase 4）。空文件也算读过。
    ctx.tracker.markRead(absPath, fingerprintContent(raw))
    if (raw === '') {
      return { output: `(file is empty: ${input.file_path})`, isError: false }
    }

    const allLines = raw.split('\n')
    const start = Math.max(0, (input.offset ?? 1) - 1)
    // limit 取正数才生效；0/负数/缺省都回落到默认上限（否则 limit:0 会读到空内容
    // 却仍把文件标记为已读，给后续 Edit 一个"读过但没看过内容"的假象）。
    const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_LIMIT
    const slice = allLines.slice(start, start + limit)

    // 逐行拼装并累计字符数：先撞行数窗口、再撞字符上限，任一触顶都在行边界停下。
    const rendered: string[] = []
    let used = 0
    let charCapped = false
    for (let i = 0; i < slice.length; i++) {
      const lineNo = start + i + 1
      const text =
        slice[i]!.length > MAX_LINE_LENGTH
          ? slice[i]!.slice(0, MAX_LINE_LENGTH) + '…[truncated]'
          : slice[i]!
      const piece = `${lineNo}\t${text}`
      // 至少给出一行；之后若再加这行会超字符上限就停下（保证行完整、不腰斩一行）。
      if (rendered.length > 0 && used + piece.length + 1 > MAX_OUTPUT_CHARS) {
        charCapped = true
        break
      }
      rendered.push(piece)
      used += piece.length + 1
    }

    const lastLine = start + rendered.length // 已展示到的（1-based 之后一行的）边界
    // 两种截断（撞字符上限 / 撞行数窗口）共用同一截断尾：标出范围并给出续读 offset，
    // 以免两条路径给模型的续读引导不一致（行数截断旧时不提示 offset）。
    let note = ''
    if (charCapped || allLines.length > start + limit) {
      const reason = charCapped ? `output reached ~${MAX_OUTPUT_CHARS} chars (token budget); ` : ''
      note =
        `\n\n[truncated: ${reason}showing lines ${start + 1}-${lastLine} of ${allLines.length}; ` +
        `pass offset: ${lastLine + 1} to continue]`
    }

    return { output: rendered.join('\n') + note, isError: false }
  },
}
