import { glob } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { resolve, relative, isAbsolute } from 'node:path'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 命中行数上限（让输出有界）。 */
const MAX_MATCHES = 200
/** 单行展示的字符上限。 */
const MAX_LINE_LENGTH = 500
/**
 * 单行缓冲上限（字符数）。分块流式读取时，若某一行迟迟不出现换行、缓冲已超过
 * 此值，判定为压缩/非常规文本并跳过该文件。这才是内存的真正约束 —— 文件总
 * 大小不设限，多大的"正常多行文件"（日志等）都能逐行扫完，内存只占约一行；
 * 只有"无换行的超大单行"（压缩 bundle、数据块等）才会触发跳过。参考 ripgrep
 * 对超长行/二进制的处理：按行扫，文件大小本身不是门槛。
 */
const MAX_LINE_BYTES = 1024 * 1024
/** NUL 字节：用来判定二进制文件（仿 ripgrep，遇到即停止扫描该文件）。 */
const NUL = String.fromCharCode(0)
/**
 * 默认忽略的目录：几乎不会想搜、又往往巨大的生成/依赖目录。交给 fs.glob 的
 * exclude 选项，命中即剪枝（连里面都不遍历，省掉 walk 开销），而非事后过滤。
 * 注意 glob 默认就不匹配点开头的目录（.git/.next 等），这里 .git 只是冗余兜底。
 * 要搜被忽略的目录，显式传 glob（如 "node_modules/foo/**"）即可绕过。
 */
const IGNORED_DIRS = new Set(['node_modules', '.git'])

/** glob 的 exclude 回调：路径任一段命中忽略目录则剪枝。兼容回调传入 basename
 *  或完整相对路径两种形态（按分隔符切段后逐段判断）。 */
function isIgnoredPath(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))
}

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  ignore_case?: boolean
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
      description:
        'Directory to search under. Relative paths resolve against the working directory. Defaults to cwd.',
    },
    glob: {
      type: 'string',
      description:
        'Optional glob to narrow which files are scanned, e.g. "**/*.ts". Defaults to all files.',
    },
    ignore_case: {
      type: 'boolean',
      description: 'Case-insensitive match. Defaults to false (case-sensitive).',
    },
  },
  required: ['pattern'],
}

/**
 * 命中行的展示路径：尽量给相对 cwd 的短路径；当搜索目录在 cwd 之外、相对路径
 * 会退化成一串 `../` 时，改用绝对路径，免得模型拿到一个对不上 cwd 的怪路径。
 */
function displayPath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? absPath : rel
}

/**
 * GrepTool —— 按文件内容搜索（"是什么"），手搓:用 fs.glob 枚举候选文件，
 * 分块流式逐行跑正则，命中输出 `相对路径:行号:命中行`。无 ripgrep 依赖。
 *
 * 内存安全（与文件总大小无关）：用 createReadStream 分块读 + StringDecoder
 * 跨块解码 utf8 + 手动按 \n 切行，内存只占"当前这一行"。约束落在单行上而非
 * 文件大小 —— 正常的多行大文件（日志等）能完整逐行扫完；只有遇到 NUL 字节
 * （二进制）或单行超过 MAX_LINE_BYTES（压缩/非常规文本）才跳过该文件。命中数、
 * 行长、被跳过的非文本文件数都有界并在输出里如实标注。按文件名找文件用 Glob。
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
      regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Invalid regular expression: ${message}`, isError: true }
    }

    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd

    const filePattern = input.glob ?? '**/*'
    // 默认剪掉忽略目录；但若用户的 glob 本身就指向忽略目录（如 "node_modules/**"），
    // 视为显式意图、不再过滤（仿 ripgrep：显式指定的路径优先于默认忽略）。
    const exclude = !input.glob || !isIgnoredPath(input.glob) ? isIgnoredPath : undefined
    const lines: string[] = []
    let count = 0
    let truncated = false
    let skippedNonText = 0

    try {
      outer: for await (const entry of glob(filePattern, { cwd: base, exclude })) {
        const absPath = resolve(base, entry)
        const rel = displayPath(ctx.cwd, absPath)
        const decoder = new StringDecoder('utf8')
        let buffer = ''
        let lineNo = 0
        let nonText = false

        // 测试一行并记录命中；返回 true 表示命中已达上限、应停止整轮搜索。
        // 每行都先 lineNo++（行号必须把未命中的行也数进去）。
        const recordLine = (line: string): boolean => {
          lineNo++
          if (!regex.test(line)) return false
          if (count >= MAX_MATCHES) {
            truncated = true
            return true
          }
          const text =
            line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…[truncated]' : line
          lines.push(`${rel}:${lineNo}:${text}`)
          count++
          return false
        }

        const stream = createReadStream(absPath)
        try {
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            const text = decoder.write(chunk)
            // NUL 字节 → 二进制文件，停止扫描该文件。
            if (text.includes(NUL)) {
              nonText = true
              break
            }
            buffer += text
            // 取出本次缓冲里所有完整行（以 \n 分隔）；CRLF 的尾随 \r 去掉，避免
            // 命中行夹带杂散回车、且让 `$` 锚定的正则正常匹配。
            let nl: number
            while ((nl = buffer.indexOf('\n')) !== -1) {
              let line = buffer.slice(0, nl)
              buffer = buffer.slice(nl + 1)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              if (recordLine(line)) break outer // 退出前 finally 会销毁 stream
            }
            // 一行迟迟不出现换行、缓冲超限：判为压缩/非常规文本，跳过该文件。
            if (buffer.length > MAX_LINE_BYTES) {
              nonText = true
              break
            }
          }
          // EOF：处理最后一段（没有尾随 \n 的最后一行）。
          if (!nonText) {
            buffer += decoder.end()
            if (buffer.length > 0) {
              if (buffer.includes(NUL)) {
                nonText = true
              } else {
                const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
                if (recordLine(line)) break outer
              }
            }
          }
        } catch {
          // 目录(EISDIR)/权限/读取错误：跳过该文件。
        } finally {
          stream.destroy()
        }

        if (nonText) skippedNonText++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Grep failed: ${message}`, isError: true }
    }

    if (lines.length === 0) {
      const skip = skippedNonText > 0 ? ` (${skippedNonText} non-text file(s) skipped)` : ''
      return { output: `No matches for: ${input.pattern}${skip}`, isError: false }
    }

    const notes: string[] = []
    if (truncated) notes.push(`showing first ${MAX_MATCHES} matches`)
    if (skippedNonText > 0) notes.push(`${skippedNonText} non-text file(s) skipped`)
    const note = notes.length > 0 ? `\n\n[${notes.join('; ')}]` : ''
    return { output: lines.join('\n') + note, isError: false }
  },
}
