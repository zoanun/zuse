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
