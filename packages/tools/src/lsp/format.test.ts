import { describe, it, expect } from 'vitest'
import { SymbolKind } from 'vscode-languageserver-protocol'
import { uriToRelPath, formatDefinition, formatReferences, formatHover, formatSymbols } from './format.js'

// 测试用的 CWD 与 URI 构造
const CWD = process.platform === 'win32' ? 'C:\\proj' : '/proj'
function uri(rel: string): string {
  // 构造一个 file:// uri,相对 CWD
  const abs = (process.platform === 'win32' ? 'C:\\proj\\' : '/proj/') + rel
  return process.platform === 'win32'
    ? 'file:///C:/proj/' + rel
    : 'file://' + abs
}
// 模拟源码行内容
const lineText = (): string => '  export function fooBar(x) {'

describe('uriToRelPath', () => {
  it('converts a file uri to a path relative to cwd', () => {
    // 将反斜杠统一为正斜杠,保证 win/posix 下断言一致
    expect(uriToRelPath(uri('src/a.ts'), CWD).replace(/\\/g, '/')).toBe('src/a.ts')
  })
})

describe('formatDefinition', () => {
  it('renders file:line:col with the source line', () => {
    // 0-based 41 行 16 列 → 显示 1-based 42 行 17 列
    const loc = { uri: uri('src/a.ts'), range: { start: { line: 41, character: 16 }, end: { line: 41, character: 22 } } }
    const out = formatDefinition([loc], CWD, () => lineText())
    expect(out).toContain('src/a.ts:42:17')
    expect(out).toContain('export function fooBar')
  })
  it('reports not found on empty', () => {
    expect(formatDefinition([], CWD, () => '', 'foo')).toMatch(/not found/i)
  })
})

describe('formatReferences', () => {
  it('groups by file and caps at the limit', () => {
    // 构造 150 条引用,limit=100,应显示 "and 50 more"
    const locs = Array.from({ length: 150 }, (_, i) => ({
      uri: uri('src/a.ts'),
      range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } },
    }))
    const out = formatReferences(locs, CWD, () => 'someLine', 100)
    expect(out).toMatch(/and 50 more/i)
  })
})

describe('formatSymbols', () => {
  // 构造一个带完整 location 的 SymbolInformation
  function sym(name: string, kind: SymbolKind, line: number): never {
    return {
      name,
      kind,
      location: { uri: uri('src/a.ts'), range: { start: { line, character: 0 }, end: { line, character: 5 } } },
    } as never
  }

  it('renders path:line:col with kind label and source line', () => {
    const out = formatSymbols([sym('resolvePath', SymbolKind.Function, 20)], CWD, () => 'export function resolvePath() {}', 100, 'resolvePath')
    expect(out).toContain('src/a.ts:21:1')
    expect(out).toContain('[function] resolvePath')
    expect(out).toContain('export function resolvePath')
  })

  it('prefers exact-name matches over fuzzy ones', () => {
    // workspace/symbol 是模糊匹配，会带回 resolvePathX 之类；问 resolvePath 时只展示精确命中
    const syms = [sym('resolvePathExtra', SymbolKind.Function, 5), sym('resolvePath', SymbolKind.Function, 20)]
    const out = formatSymbols(syms, CWD, () => 'src', 100, 'resolvePath')
    expect(out).toContain(':21:')
    expect(out).not.toContain('resolvePathExtra')
  })

  it('falls back to all results when no exact match', () => {
    const out = formatSymbols([sym('resolvePathHelper', SymbolKind.Function, 5)], CWD, () => 'src', 100, 'resolvePath')
    expect(out).toContain('resolvePathHelper')
  })

  it('handles a WorkspaceSymbol whose location has no range', () => {
    // 服务器延迟解析时 WorkspaceSymbol.location 可能只有 uri
    const ws = { name: 'lazySym', kind: SymbolKind.Variable, location: { uri: uri('src/b.ts') } } as never
    const out = formatSymbols([ws], CWD, () => 'src', 100, 'lazySym')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('[variable] lazySym')
  })

  it('reports not found on empty', () => {
    expect(formatSymbols([], CWD, () => '', 100, 'nope')).toMatch(/no symbol/i)
  })
})

describe('formatHover', () => {
  it('extracts MarkupContent value', () => {
    expect(formatHover({ contents: { kind: 'markdown', value: 'type: number' } } as never, 'x')).toContain('type: number')
  })
  it('extracts plain string contents', () => {
    expect(formatHover({ contents: 'plain doc' } as never, 'x')).toContain('plain doc')
  })
  it('reports no info on null', () => {
    expect(formatHover(null, 'foo')).toMatch(/no hover/i)
  })
})
