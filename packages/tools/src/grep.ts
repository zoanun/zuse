import { spawn } from 'node:child_process'
import { rgPath } from '@vscode/ripgrep'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'
import { clampPositiveInt, pluralize } from './util.js'

/** 单行展示的字符上限：交给 ripgrep 的 --max-columns，超长行只给预览（仅 content 模式）。 */
const MAX_LINE_LENGTH = 500
/** head_limit 缺省值：与 CC 一致，限输出条数防上下文膨胀。模型可显式调大或传 0 解除。 */
const DEFAULT_HEAD_LIMIT = 250
/** head_limit=0（不限）时仍保留的安全上限，避免超大仓库一次吐出海量行撑爆上下文。 */
const UNLIMITED_SAFETY = 10_000

/** 输出模式：与 CC 对齐。files_with_matches 为默认（最省 token），content 给命中行，count 给每文件计数。 */
type OutputMode = 'content' | 'files_with_matches' | 'count'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  type?: string
  ignore_case?: boolean
  output_mode?: OutputMode
  /** content 模式：命中行前显示的上下文行数（rg -B）。 */
  before_context?: number
  /** content 模式：命中行后显示的上下文行数（rg -A）。 */
  after_context?: number
  /** content 模式：命中行前后各显示的上下文行数（rg -C，覆盖 before/after）。 */
  context?: number
  /** 输出条数上限（跨所有模式）；缺省 250，传 0 表示不限（仍受安全上限约束）。 */
  head_limit?: number
  /** 应用 head_limit 前先跳过的条数，等价于 tail -n +N | head；缺省 0。 */
  offset?: number
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Regular expression to search for in file contents (ripgrep syntax).',
    },
    path: {
      type: 'string',
      description:
        'Directory to search under. Relative paths resolve against the working directory. Defaults to cwd.',
    },
    glob: {
      type: 'string',
      description:
        'Optional glob to narrow which files are scanned, e.g. "**/*.ts" or "*.{ts,tsx}".',
    },
    type: {
      type: 'string',
      description:
        'Optional file type filter (rg --type), e.g. "js", "py", "rust", "go". Simpler than glob for standard types.',
    },
    ignore_case: {
      type: 'boolean',
      description: 'Case-insensitive match. Defaults to false (case-sensitive).',
    },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description:
        'Output mode: "files_with_matches" lists matching file paths (default, most economical); ' +
        '"content" shows matching lines as "path:line:text" (supports context); "count" shows "path:count" per file.',
    },
    before_context: {
      type: 'number',
      description: 'Lines of context before each match (rg -B). content mode only; ignored otherwise.',
    },
    after_context: {
      type: 'number',
      description: 'Lines of context after each match (rg -A). content mode only; ignored otherwise.',
    },
    context: {
      type: 'number',
      description:
        'Lines of context before AND after each match (rg -C); overrides before/after_context. content mode only.',
    },
    head_limit: {
      type: 'number',
      description:
        `Cap on output entries (lines) across all modes. Defaults to ${DEFAULT_HEAD_LIMIT}. Pass 0 for unlimited. ` +
        'Note: in content mode with context, context and "--" separator lines each count as an entry, ' +
        'so the cap bounds output lines rather than the number of matches.',
    },
    offset: {
      type: 'number',
      description: 'Skip the first N output entries before applying head_limit. Defaults to 0.',
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
 * 把请求参数翻译成 ripgrep 命令行参数。按 output_mode 走不同分支：
 *  - content：--line-number + --max-columns（超长行预览）+ 可选上下文（-C / -B / -A）
 *  - files_with_matches：--files-with-matches（rg -l），只列路径
 *  - count：--count + --with-filename，输出 "path:count"
 * 上下文参数仅在 content 模式拼入（其余模式无意义，直接忽略，对齐 CC）。
 */
function buildArgs(input: GrepInput, mode: OutputMode, searchPath: string): string[] {
  const args = ['--color', 'never', '--no-messages']
  if (input.ignore_case) args.push('--ignore-case')
  if (input.glob) args.push('--glob', input.glob)
  if (input.type) args.push('--type', input.type)

  if (mode === 'files_with_matches') {
    args.push('--files-with-matches')
  } else if (mode === 'count') {
    args.push('--count', '--no-heading', '--with-filename')
  } else {
    args.push(
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--crlf', // 让 `$` 在 CRLF 文件上锚定到 \r 之前
      '--max-columns',
      String(MAX_LINE_LENGTH),
      '--max-columns-preview', // 超长行给一段预览，而非整行丢弃
    )
    // 上下文：context 覆盖 before/after；任一为正数才拼入（0/缺省回落到 0 = 不加该 flag）。
    const ctxBoth = clampPositiveInt(input.context, 0)
    if (ctxBoth > 0) {
      args.push('--context', String(ctxBoth))
    } else {
      const before = clampPositiveInt(input.before_context, 0)
      const after = clampPositiveInt(input.after_context, 0)
      if (before > 0) args.push('--before-context', String(before))
      if (after > 0) args.push('--after-context', String(after))
    }
  }

  args.push('-e', input.pattern, '--', searchPath)
  return args
}

/**
 * GrepTool —— 按文件内容搜索（"是什么"），后端是 ripgrep（经 @vscode/ripgrep
 * 提供的预编译 rg 二进制）。与 Claude Code 一致：直接复用 ripgrep，免费获得完整的
 * gitignore 语义、二进制跳过、超长行截断、Unicode 等能力。
 *
 * 与 CC 对齐的能力：output_mode（默认 files_with_matches，另有 content / count）、
 * content 模式的上下文行（before/after/context = rg -B/-A/-C）、type 文件类型过滤、
 * head_limit + offset 分页（缺省 250，0 解除）。按文件名找文件用 Glob。
 */
export const GrepTool: Tool = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression (powered by ripgrep). Respects .gitignore. ' +
    'output_mode selects the result shape: "files_with_matches" (default) lists paths, ' +
    '"content" shows "path:line:text" with optional context lines, "count" shows per-file counts. ' +
    'Narrow with glob or type. Use head_limit/offset to page; Glob to find files by name.',
  inputSchema,
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    // 返回搜索目录作为限定符；未指定时返回 '.' 表示当前目录。
    const p = (input as { path?: unknown }).path
    return typeof p === 'string' ? p : '.'
  },

  run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GrepInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return Promise.resolve({ output: 'Grep requires a pattern.', isError: true })
    }

    const mode: OutputMode = input.output_mode ?? 'files_with_matches'

    // 分页：effLimit 为有效条数上限；offset 为先跳过的条数。
    const unlimited = input.head_limit === 0
    const effLimit = unlimited ? UNLIMITED_SAFETY : clampPositiveInt(input.head_limit, DEFAULT_HEAD_LIMIT)
    const offset = clampPositiveInt(input.offset, 0)
    // 多收一条用来判断"还有更多"：收到 offset+effLimit+1 条即可停。
    const stopAt = offset + effLimit + 1

    // 给了 path 就解析成绝对路径（rg 会原样输出绝对路径前缀）；否则搜当前目录 '.'。
    const searchPath = input.path ? resolvePath(ctx.cwd, input.path) : '.'
    const args = buildArgs(input, mode, searchPath)

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(rgPath, args, { cwd: ctx.cwd, signal: ctx.signal })
      const lines: string[] = []
      let stdoutBuf = ''
      let stderr = ''
      let stopped = false // 已收满 stopAt、提前杀进程
      let settled = false

      const finish = (result: ToolResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      // 把一行 rg 输出规整后收入 lines；返回 true 表示已达上限、应停止读取。
      const pushLine = (raw: string): boolean => {
        let line = raw
        if (line.endsWith('\r')) line = line.slice(0, -1) // CRLF 残留
        line = stripDotPrefix(line)
        lines.push(line)
        if (lines.length >= stopAt) {
          stopped = true
          child.kill()
          return true
        }
        return false
      }

      // 收尾：按 offset/effLimit 切片，拼输出与截断提示。供正常结束与提前停止共用。
      const buildResult = (): ToolResult => {
        const shown = lines.slice(offset, offset + effLimit)
        if (shown.length === 0) {
          if (lines.length > 0) {
            return {
              output: `[offset ${offset} is past the ${lines.length} result(s)]`,
              isError: false,
            }
          }
          return { output: `No matches for: ${input.pattern}`, isError: false }
        }
        // 还有更多：要么提前停止，要么收集数超过了展示窗口尾。
        const hasMore = stopped || lines.length > offset + effLimit
        let note = ''
        if (hasMore) {
          note = unlimited
            ? `\n\n[safety cap: showing first ${UNLIMITED_SAFETY} entries]`
            : `\n\n[truncated: showing ${shown.length} ${pluralize(shown.length, 'entry', 'entries')}` +
              `${offset ? ` from offset ${offset}` : ''}; raise head_limit (0 = all) for more]`
        }
        return { output: shown.join('\n') + note, isError: false }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stopped) return
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
        if (stopped) {
          finish(buildResult())
          return
        }
        // 处理没有尾随换行的最后一行。
        if (stdoutBuf.length > 0) pushLine(stdoutBuf)
        // rg 退出码：0=有命中，1=无命中（非错误），其余=出错（含非法正则、未知 type）。
        if (code === 0) {
          finish(buildResult())
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

export const toolModule = { make: () => GrepTool } satisfies import('./tool-module.js').ToolModule
