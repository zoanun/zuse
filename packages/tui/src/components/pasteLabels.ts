/** 把一行 displayText 切成「普通文本 / 粘贴标签（带 id）」段，供回显渲染包链接。 */
export interface LabelSeg {
  text: string
  id?: number
}

// 匹配 [粘贴#<id> · ... 字符] 标签（与 pasteFold.tagLabel 文案对应）。
const LABEL_RE = /\[粘贴#(\d+) · [^\]]*\]/g

export function splitPasteLabels(line: string): LabelSeg[] {
  const segs: LabelSeg[] = []
  let last = 0
  for (const m of line.matchAll(LABEL_RE)) {
    const idx = m.index ?? 0
    if (idx > last) segs.push({ text: line.slice(last, idx) })
    segs.push({ text: m[0], id: parseInt(m[1]!, 10) })
    last = idx + m[0].length
  }
  if (last < line.length) segs.push({ text: line.slice(last) })
  // 空串或无匹配：至少返回一段（可能是空文本）
  if (segs.length === 0) segs.push({ text: '' })
  return segs
}
