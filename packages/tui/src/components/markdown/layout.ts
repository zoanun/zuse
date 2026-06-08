import stringWidth from 'string-width'

/** 计算字符串在终端的显示宽度(全角/中文字符算 2 列)。 */
export function displayWidth(text: string): number {
  return stringWidth(text)
}

/** 还原 marked 转义的 5 个 HTML 实体;&amp; 放最后解码,避免二次解码。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 列表项前缀:有序为 "N. "(从 start 起算),无序为 "• "。 */
export function listPrefix(ordered: boolean, index: number, start: number): string {
  return ordered ? `${start + index}. ` : '• '
}

/** 单元格对齐方式。 */
export type CellAlign = 'left' | 'center' | 'right'

/** 按显示宽度折行;不从全角字符中间劈开(按 Unicode 码点遍历)。 */
export function wrapCell(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let lineWidth = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    // 当前行非空且再加这个字符会超宽,则先换行。
    if (line !== '' && lineWidth + w > width) {
      lines.push(line)
      line = ''
      lineWidth = 0
    }
    line += ch
    lineWidth += w
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

/**
 * 计算各列宽度。rows 含表头,每行是各列文本。
 * 总宽(Σ列宽 + 3×列数 + 1)超过 maxWidth 时,按自然宽度比例压缩内容预算。
 */
export function computeColumnWidths(rows: string[][], maxWidth: number): number[] {
  const cols = rows[0]?.length ?? 0
  if (cols === 0) return []
  const natural: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = 0
    for (const row of rows) w = Math.max(w, displayWidth(row[c] ?? ''))
    natural[c] = w
  }
  const overhead = cols * 3 + 1
  const naturalSum = natural.reduce((a, b) => a + b, 0)
  if (naturalSum + overhead <= maxWidth) return natural
  // 超宽:把可用内容预算按自然宽度比例分给各列,每列至少 1。
  const contentBudget = Math.max(cols, maxWidth - overhead)
  const denom = naturalSum || 1
  return natural.map((w) => Math.max(1, Math.floor((w / denom) * contentBudget)))
}
