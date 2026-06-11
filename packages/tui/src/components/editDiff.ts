/** diff 中的一行:未变上下文 / 新增 / 删除。 */
export type DiffRow = { kind: 'context' | 'add' | 'del'; text: string }

/**
 * 按 \n 切行;去掉尾随换行产生的末尾空串(渲染时不额外造空行),保留中间空行。
 * 例:'a\nb\n' → ['a','b'];'' → [''];'a' → ['a']。
 */
function splitLines(s: string): string[] {
  const lines = s.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 行级 LCS diff:对 old/new 两段做最长公共子序列,未变行作上下文,
 * 变动行打 del(仅 old)/ add(仅 new)。回溯保证「删在增前、上下文按原位」。
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = splitLines(oldStr)
  const b = splitLines(newStr)
  const m = a.length
  const n = b.length
  // lcs[i][j] = a[i..] 与 b[j..] 的 LCS 长度(后缀表)。
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  // 回溯:相等→context;否则按 LCS 取较优方向,平手时优先 del(保证删在增前)。
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      rows.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) {
    rows.push({ kind: 'del', text: a[i]! })
    i++
  }
  while (j < n) {
    rows.push({ kind: 'add', text: b[j]! })
    j++
  }
  return rows
}

/** 统计新增 / 删除行数(供标题行的 +A -R)。 */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}

/** 收口:取前 max 行,more = 截掉的行数(为 0 表示未截)。 */
export function capDiff(rows: DiffRow[], max: number): { rows: DiffRow[]; more: number } {
  if (rows.length <= max) return { rows, more: 0 }
  return { rows: rows.slice(0, max), more: rows.length - max }
}

/** Edit diff 在 OUT 列行内展示的最大行数;超出收口为「… +N 行」并落盘完整 diff 供链接。 */
export const EDIT_DIFF_CAP = 10

/** diff 行按 add/del/context 加前缀。 */
function rowPrefix(kind: DiffRow['kind']): string {
  return kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  '
}

/**
 * 把完整(未截断)diff 渲染成纯文本,落盘到临时文件供「… +N 行」链接打开。
 * 首行 `Updated <file>  +A -R`,随后每行带 +/-/空 前缀 —— 与行内彩色 diff 同形,只是不收口、无颜色。
 */
export function formatDiffText(file: string, rows: DiffRow[]): string {
  const { added, removed } = diffStats(rows)
  const header = `Updated ${file}  +${added} -${removed}`
  const body = rows.map((r) => `${rowPrefix(r.kind)}${r.text}`)
  return [header, ...body].join('\n')
}
