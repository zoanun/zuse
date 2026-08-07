import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep, matchesGlob } from 'node:path'
import { resolvePath } from '@zuse/core'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/**
 * 收集（遍历）的硬上限：避免在超大目录树上无限收集。注意这是「内部收集」的天花板，
 * 不是「喂给模型」的条数 —— 见 RESULT_LIMIT。
 */
const HARD_CAP = 10_000

/**
 * 喂给模型的命中条数上限（与 CC 的 Glob 同一取舍：宁可只回一截 + 「太多了，缩小范围」，
 * 也不把成百上千条路径灌进上下文撑爆它）。CC 默认 100、本仓库 Grep 默认 250；这里取 200，
 * 比 CC 略宽，让寻常的定向 glob（如 src 下按扩展名找的那类）大多不触发截断，又把最坏情况
 * 牢牢压在数 KB / ~2k token 量级。
 *
 * 关键：我们仍**内部收集全量**（至多 HARD_CAP）再按 mtime 倒序排序，故①回给模型的是
 * mtime **最新的** RESULT_LIMIT 条（而非遍历到的前 N 条），②截断注记里能写出**真实总数**
 * （CC 截断后并不知道总共多少）。注记形如 `[truncated: showing first 200 of 1432 …]`，
 * 会被展示层的 stripTrailingNotes 剥除。
 *
 * （历史 bug 与权衡：曾硬截 100 且**不附注记** —— 模型/展示层都不知道被截过，徽标与
 *  「查看全部」临时文件据残缺的 100 条派生，既少报又名不副实。我一度改为「整份返回、只在
 *  展示层截」修掉了它，但那等于把模型侧上下文护栏从 100 放宽到 10000；经评审改回 CC 的
 *  「截模型 + 如实注记」路线 —— 护栏回到位，且注记带真实总数比旧实现更诚实。）
 */
const RESULT_LIMIT = 200
/**
 * 遍历时直接剪枝、不下钻的目录：这两个几乎必然巨大、又几乎不会想用通配符去翻。
 * 与 CC 的取舍说明：CC 的 Glob 默认连 gitignore 都不应用（包含被忽略的文件），
 * 但我们这里既要能找到 `.env`/`.gitignore` 这类常被 gitignore 掉的隐藏文件
 * （所以不能套 gitignore），又不想每次 Glob 都去走一遍 node_modules/.git —— 折中
 * 就是只硬剪这两个目录。其余隐藏文件/目录照常包含，故对 `.env` 这类隐藏文件能命中。
 */
const PRUNED_DIRS = new Set(['.git', 'node_modules'])

interface GlobInput {
  pattern: string
  cwd?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Glob pattern, e.g. "**/*.ts" or "src/**/test-*.tsx".',
    },
    cwd: {
      type: 'string',
      description:
        'Directory to search from. Relative paths resolve against the working directory. Defaults to cwd.',
    },
  },
  required: ['pattern'],
}

interface GlobMatch {
  rel: string
  mtimeMs: number
}

/**
 * 从 dir 递归收集匹配 pattern 的文件（路径相对 base、统一用 '/' 分隔后再匹配，
 * 以兼容 Windows 的 '\\'）。隐藏文件一并纳入（修掉 fs.glob 的 dotfile 全盲），
 * 但不下钻 PRUNED_DIRS。每个命中文件 stat 一次拿 mtime 供排序；达到 HARD_CAP 即止。
 */
async function collect(
  base: string,
  dir: string,
  pattern: string,
  matches: GlobMatch[],
  signal: AbortSignal,
): Promise<void> {
  if (matches.length >= HARD_CAP) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 无权限/不可读：跳过该目录
  }
  for (const entry of entries) {
    if (signal.aborted) throw new Error('Glob aborted')
    if (matches.length >= HARD_CAP) return
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (PRUNED_DIRS.has(entry.name)) continue
      await collect(base, abs, pattern, matches, signal)
    } else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join('/')
      if (matchesGlob(rel, pattern)) {
        try {
          const info = await stat(abs)
          matches.push({ rel, mtimeMs: info.mtimeMs })
        } catch {
          // stat 失败（竞态删除等）：跳过
        }
      }
    }
    // 软链接（既非目录也非普通文件的 dirent）跳过，避免成环。
  }
}

/**
 * GlobTool —— 按文件名/路径匹配查找文件（"在哪儿"）。与 Claude Code 一致，这是个
 * 内部实现的工具（CC 的 Glob 也非 ripgrep 后端，无现成 OSS 二进制可换）：自写
 * readdir 递归遍历 + Node 22 内置的 `path.matchesGlob` 做匹配，零依赖。
 *
 * 对齐要点：结果按**修改时间倒序**（最近改的在前，跟 CC 一致），不是字母序；隐藏
 * 文件一并包含（CC 的 Glob 默认也含 gitignore 掉的文件）。只看路径不看内容，按
 * 内容找用 Grep。回给模型的条数上限见 RESULT_LIMIT（超出附带真实总数的截断注记）。
 */
export const GlobTool: Tool = {
  name: 'Glob',
  description:
    'Find files by path/name using a glob pattern (e.g. "**/*.ts"). Returns matching file paths ' +
    'sorted by modification time (most recent first). Use Grep to search file contents instead.',
  inputSchema,
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    // 返回**搜索根**（未指定时 '.'），与 Grep 对齐 —— 不是 pattern。
    //
    // 曾经返回 pattern，那是个洞：真正决定能读到哪些文件的是 `cwd` 字段（见 run() 里的
    // `base`），权限层却拿模式串去比。于是 `{pattern:'**', cwd:'~/.ssh'}` 报给权限层的
    // 限定符是 `**`（看着像"就在本项目里搜"），实际枚举的是家目录的私钥目录,而
    // `deny: Glob(~/.ssh/**)` 完全拦不住 —— 实测能列出 id_ed25519 等文件名。
    // pattern 本身逃不出 base（collect() 是从 base 往下走目录树、拿 relative(base, abs)
    // 去比模式），所以只校验搜索根就是完备的。
    const c = (input as { cwd?: unknown }).cwd
    return typeof c === 'string' ? c : '.'
  },

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as GlobInput
    if (!input.pattern || typeof input.pattern !== 'string') {
      return { output: 'Glob requires a pattern.', isError: true }
    }

    const base = input.cwd ? resolvePath(ctx.cwd, input.cwd) : ctx.cwd

    const matches: GlobMatch[] = []
    try {
      await collect(base, base, input.pattern, matches, ctx.signal)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `Glob failed: ${message}`, isError: true }
    }

    if (matches.length === 0) {
      return { output: `No files match: ${input.pattern}`, isError: false }
    }

    // 按 mtime 倒序：最近修改的排在前面（与 CC 的 Glob 一致）。
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    // 只回 mtime 最新的 RESULT_LIMIT 条；超出则附一条带真实总数的截断注记，提示模型缩小
    // pattern。注记会被展示层 stripTrailingNotes 剥除（详见 RESULT_LIMIT 注释）。
    const total = matches.length
    const shown = matches.slice(0, RESULT_LIMIT)
    let note = ''
    if (total > RESULT_LIMIT) {
      // 收集触顶 HARD_CAP 时真实总数可能更多，用 `N+` 表示这是下界。
      const totalLabel = total >= HARD_CAP ? `${HARD_CAP}+` : String(total)
      note = `\n\n[truncated: showing first ${RESULT_LIMIT} of ${totalLabel} matches; narrow the pattern for the rest]`
    }
    return { output: shown.map((m) => m.rel).join('\n') + note, isError: false }
  },
}

export const toolModule = { make: () => GlobTool } satisfies import('./tool-module.js').ToolModule
