import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Location, Hover, MarkupContent } from 'vscode-languageserver-protocol'

/** 读某绝对路径某 0-based 行的源码(注入以便测试,不打真实 fs)。 */
export type LineReader = (absPath: string, line0: number) => string

// 悬停文本最大长度,超出截断
const MAX_HOVER = 4_000

/**
 * file:// uri → 相对 cwd 的路径(用于展示)。
 * 使用 Node 内置 url.fileURLToPath 做 uri→绝对路径,再 path.relative 求相对路径。
 * Windows 下将反斜杠统一转为正斜杠,保证输出跨平台一致。
 */
export function uriToRelPath(uri: string, cwd: string): string {
  const abs = fileURLToPath(uri)
  const rel = path.relative(cwd, abs)
  // rel 为空字符串时(uri 本身就是 cwd)返回绝对路径兜底;
  // 统一用正斜杠(展示用途,不走 fs)
  return (rel || abs).replace(/\\/g, '/')
}

/**
 * 格式化 definition 结果:每条输出「路径:行:列」+ 目标行源码。
 * 行列从 0-based(LSP 约定)转 1-based(人类可读)。
 * locs 为空时报 not found。
 */
export function formatDefinition(
  locs: Location[],
  cwd: string,
  readLine: LineReader,
  symbol?: string,
): string {
  if (locs.length === 0) {
    return `Definition not found${symbol ? ` for: ${symbol}` : ''}`
  }
  return locs
    .map((l) => {
      // 路径:1-based 行:1-based 列
      const rel = uriToRelPath(l.uri, cwd)
      const ln = l.range.start.line   // 0-based
      const col = l.range.start.character  // 0-based
      const src = readLine(fileURLToPath(l.uri), ln).trim()
      return `${rel}:${ln + 1}:${col + 1}\n  ${src}`
    })
    .join('\n\n')
}

/**
 * 格式化 references 结果:按文件分组,每条显示「行:列  源码行」。
 * 超过 limit 条时截断并提示剩余数量。
 * locs 为空时报 no references。
 */
export function formatReferences(
  locs: Location[],
  cwd: string,
  readLine: LineReader,
  limit: number,
  symbol?: string,
): string {
  if (locs.length === 0) {
    return `No references found${symbol ? ` for: ${symbol}` : ''}`
  }
  // 只展示前 limit 条,超出部分在末尾提示
  const shown = locs.slice(0, limit)

  // 按相对路径分组
  const byFile = new Map<string, Location[]>()
  for (const l of shown) {
    const rel = uriToRelPath(l.uri, cwd)
    const arr = byFile.get(rel) ?? []
    arr.push(l)
    byFile.set(rel, arr)
  }

  const blocks: string[] = []
  for (const [rel, group] of byFile) {
    const lines = group.map((l) => {
      const src = readLine(fileURLToPath(l.uri), l.range.start.line).trim()
      // 行列均转 1-based
      return `  ${l.range.start.line + 1}:${l.range.start.character + 1}  ${src}`
    })
    blocks.push(`${rel}\n${lines.join('\n')}`)
  }

  let out = `Found ${locs.length} reference(s):\n\n${blocks.join('\n\n')}`
  // 超出 limit 的部分追加提示
  if (locs.length > limit) {
    out += `\n\n… and ${locs.length - limit} more references`
  }
  return out
}

/**
 * 格式化 hover 结果:从 Hover.contents 抽取纯文本。
 * 支持 MarkupContent / MarkedString / 数组 / 纯字符串四种形态。
 * hover 为 null 时报 no hover info。
 */
export function formatHover(hover: Hover | null, symbol?: string): string {
  if (!hover || hover.contents == null) {
    return `No hover info${symbol ? ` for: ${symbol}` : ''}`
  }
  const c = hover.contents
  let text: string
  if (typeof c === 'string') {
    // 纯字符串
    text = c
  } else if (Array.isArray(c)) {
    // MarkedString 数组:元素可以是 string 或 { language, value }
    text = c.map((p) => (typeof p === 'string' ? p : p.value)).join('\n')
  } else if (typeof (c as MarkupContent).value === 'string') {
    // MarkupContent:{ kind, value }
    text = (c as MarkupContent).value
  } else {
    text = String((c as { value?: unknown }).value ?? '')
  }

  text = text.trim()
  // 超出最大长度时截断
  if (text.length > MAX_HOVER) {
    text = text.slice(0, MAX_HOVER) + '\n…[truncated]'
  }
  return text || `No hover info${symbol ? ` for: ${symbol}` : ''}`
}
