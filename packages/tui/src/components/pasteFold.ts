import { type TextBuffer } from './textBuffer.js'

// PUA 哨兵:包裹折叠粘贴的自增 id。正常文本不会出现这两个码位;粘贴内容自带时折叠前剥除。
export const PASTE_START = '\u{E000}'
export const PASTE_END = '\u{E001}'

export type PasteMap = ReadonlyMap<number, string>

// 匹配一个占位符 span:START + 十进制 id + END
const SPAN_RE = /\u{E000}(\d+)\u{E001}/gu

export interface Span {
  start: number
  end: number
  id: number
}

/** 扫出 text 里所有占位符 span(按出现顺序)。 */
export function spans(text: string): Span[] {
  const out: Span[] = []
  for (const m of text.matchAll(SPAN_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, id: parseInt(m[1]!, 10) })
  }
  return out
}

/** 标签文案:粘贴#{id} · {N} 行 · {M} 字符(M≥1000 → x.xk)。 */
export function tagLabel(id: number, content: string): string {
  const numLines = content.split('\n').length
  const chars = content.length
  const charStr = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
  return `粘贴#${id} · ${numLines} 行 · ${charStr} 字符`
}

/** 折叠一次粘贴:剥哨兵、分配 id、存内容、在光标处插入哨兵 span。 */
export function foldPaste(
  buf: TextBuffer,
  pastes: PasteMap,
  nextId: number,
  content: string,
): { buf: TextBuffer; pastes: Map<number, string>; nextId: number } {
  // 剥除粘贴内容里可能夹带的哨兵字符,避免嵌套占位符
  const clean = content.split(PASTE_START).join('').split(PASTE_END).join('')
  const id = nextId
  const span = PASTE_START + id + PASTE_END
  const text = buf.text.slice(0, buf.cursor) + span + buf.text.slice(buf.cursor)
  const newPastes = new Map(pastes)
  newPastes.set(id, clean)
  return { buf: { text, cursor: buf.cursor + span.length }, pastes: newPastes, nextId: nextId + 1 }
}

/** 哨兵 span → 全文(发模型);未知 id 退化为字面。 */
export function expand(text: string, pastes: PasteMap): string {
  return text.replace(SPAN_RE, (full, idStr: string) => {
    const c = pastes.get(parseInt(idStr, 10))
    return c === undefined ? full : c
  })
}

/** 哨兵 span → 可见标签串 [label];未知 id 退化为字面。 */
export function toDisplay(text: string, pastes: PasteMap): string {
  return text.replace(SPAN_RE, (full, idStr: string) => {
    const id = parseInt(idStr, 10)
    const c = pastes.get(id)
    return c === undefined ? full : `[${tagLabel(id, c)}]`
  })
}

/** 光标偏移 → toDisplay 后字符串的偏移(光标不在 span 内部,故可逐段累加)。 */
export function toDisplayCursor(text: string, cursor: number, pastes: PasteMap): number {
  const sp = spans(text)
  let disp = 0
  let i = 0
  let si = 0
  while (i < cursor) {
    if (si < sp.length && sp[si]!.start === i) {
      const { id, start, end } = sp[si]!
      const c = pastes.get(id)
      disp += c === undefined ? end - start : `[${tagLabel(id, c)}]`.length
      i = end
      si++
    } else {
      disp++
      i++
    }
  }
  return disp
}
