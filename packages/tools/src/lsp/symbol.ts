import type { Position } from 'vscode-languageserver-protocol'

/** 符号在文件中的定位结果。 */
export interface SymbolLocation {
  /** 0-based LSP 位置（character 为 UTF-16 码元偏移）。 */
  position: Position
  /** 实际命中的 1-based 行号，回喂给用户看。 */
  matchedLine: number
}

/** 正则元字符转义，让 symbol 当字面量匹配。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在 text 里按词边界定位 symbol。
 * 给了 line（1-based）就只在该行找首次出现；没给就全文逐行找首个命中行的首次出现。
 * 找不到返回 null。
 */
export function locateSymbol(text: string, symbol: string, line?: number): SymbolLocation | null {
  const lines = text.split('\n')
  // 使用词边界确保不会把 foo 匹配到 foobar 内部
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
  const search = (idx: number): SymbolLocation | null => {
    // noUncheckedIndexedAccess 下 lines[idx] 为 string | undefined，越界兜底为空串
    const m = re.exec(lines[idx] ?? '')
    return m ? { position: { line: idx, character: m.index }, matchedLine: idx + 1 } : null
  }
  if (line !== undefined) {
    const idx = line - 1
    // 行号越界直接返回 null
    if (idx < 0 || idx >= lines.length) return null
    return search(idx)
  }
  // 未指定行，遍历全文找首个命中
  for (let i = 0; i < lines.length; i++) {
    const r = search(i)
    if (r) return r
  }
  return null
}
