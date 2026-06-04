import { spawn } from 'node:child_process'
import { rgPath } from '@vscode/ripgrep'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 命中行数上限（让输出有界）。达到即杀掉 rg 进程并标注截断。 */
const MAX_MATCHES = 200
/** 单行展示的字符上限：交给 ripgrep 的 --max-columns，超长行只给预览。 */
const MAX_LINE_LENGTH = 500

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

/** rg 在搜索当前目录 '.' 时会给每条路径加 './'（Windows 下为 '.\'）前缀，去掉它。 */
function stripDotPrefix(line: string): string {
  if (line.startsWith('./') || line.startsWith('.\\')) return line.slice(2)
  return line
}

/**
 * GrepTool —— 按文件内容搜索（"是什么"），后端是 ripgrep（经 @vscode/ripgrep
 * 提供的预编译 rg 二进制）。这与 Claude Code 一致：直接复用 ripgrep，而不是手搓
 * 文件遍历 + 正则。由此免费获得完整的 gitignore 语义（嵌套 .gitignore、.ignore、
 * .rgignore、全局 gitignore、否定规则等）、二进制文件自动跳过、超长行截断、
 * Unicode 等能力——这些都不必我们自己维护。
 *
 * 输出为 `路径:行号:命中行`。命中数上限 MAX_MATCHES，单行长度上限 MAX_LINE_LENGTH
 * （交给 rg 的 --max-columns）。注意：gitignore 仅在搜索目录处于 git 仓库内（存在
 * .git）时才生效，这正是 ripgrep 的原生行为，与 CC 对齐。按文件名找文件用 Glob。
 */
export const GrepTool: Tool = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression (powered by ripgrep). Returns matches as ' +
    '"path:line:text". Respects .gitignore. Use the glob option to narrow which files are ' +
    'scanned. Use Glob to find files by name instead.',
  inputSchema,

  run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GrepInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return Promise.resolve({ output: 'Grep requires a pattern.', isError: true })
    }

    // 给了 path 就解析成绝对路径（rg 会原样输出绝对路径前缀）；否则搜当前目录 '.'。
    const searchPath = input.path ? resolvePath(ctx.cwd, input.path) : '.'

    const args = [
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--color',
      'never',
      '--crlf', // 让 `$` 在 CRLF 文件上锚定到 \r 之前
      '--no-messages', // 抑制无法读取的文件等噪声（非法正则仍会照常报错）
      '--max-columns',
      String(MAX_LINE_LENGTH),
      '--max-columns-preview', // 超长行给一段预览，而非整行丢弃
    ]
    if (input.ignore_case) args.push('--ignore-case')
    if (input.glob) args.push('--glob', input.glob)
    args.push('-e', input.pattern, '--', searchPath)

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(rgPath, args, { cwd: ctx.cwd, signal: ctx.signal })
      const lines: string[] = []
      let stdoutBuf = ''
      let stderr = ''
      let truncated = false
      let settled = false

      const finish = (result: ToolResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      // 把一行 rg 输出规整后收入 lines；返回 true 表示已达上限、应停止。
      const pushLine = (raw: string): boolean => {
        let line = raw
        if (line.endsWith('\r')) line = line.slice(0, -1) // CRLF 残留
        line = stripDotPrefix(line)
        lines.push(line)
        if (lines.length >= MAX_MATCHES) {
          truncated = true
          child.kill()
          return true
        }
        return false
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (truncated) return
        stdoutBuf += chunk
        let nl: number
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const raw = stdoutBuf.slice(0, nl)
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (pushLine(raw)) break
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', (err: Error) => {
        finish({ output: `Grep failed to launch ripgrep: ${err.message}`, isError: true })
      })

      child.on('close', (code: number | null) => {
        if (truncated) {
          finish({
            output: lines.join('\n') + `\n\n[showing first ${MAX_MATCHES} matches]`,
            isError: false,
          })
          return
        }
        // 处理没有尾随换行的最后一行。
        if (stdoutBuf.length > 0) pushLine(stdoutBuf)
        if (truncated) {
          finish({
            output: lines.join('\n') + `\n\n[showing first ${MAX_MATCHES} matches]`,
            isError: false,
          })
          return
        }
        // rg 退出码：0=有命中，1=无命中（非错误），其余=出错（含非法正则）。
        if (code === 0) {
          finish({ output: lines.join('\n'), isError: false })
        } else if (code === 1) {
          finish({ output: `No matches for: ${input.pattern}`, isError: false })
        } else {
          const detail = stderr.trim() || `ripgrep exited with code ${code}`
          finish({ output: `Grep failed: ${detail}`, isError: true })
        }
      })
    })
  },
}
