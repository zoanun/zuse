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
