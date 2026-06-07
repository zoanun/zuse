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

/** 把文本按显示宽度补齐到 width;文本本身更宽则原样返回。 */
export function padCell(text: string, width: number, align: CellAlign): string {
  const pad = width - displayWidth(text)
  if (pad <= 0) return text
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  return text + ' '.repeat(pad)
}

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
