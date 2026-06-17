import {
  insert,
  backspace,
  deleteForward,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveBufferStart,
  moveBufferEnd,
  reduce,
  type TextBuffer,
  type InputEvent,
} from './textBuffer.js'

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
  // 剥除粘贴内容里可能夹带的哨兵字符,避免嵌套占位符;trim 去尾部空行,防止单行粘贴被误算成多行
  const clean = content.split(PASTE_START).join('').split(PASTE_END).join('').trim()
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

/** 位置严格落在某 span 内则吸附到更近边界。 */
function snapOut(text: string, pos: number): number {
  for (const s of spans(text)) {
    if (pos > s.start && pos < s.end) return pos - s.start <= s.end - pos ? s.start : s.end
  }
  return pos
}

/** 左移落点在 span 内 → 吸到 span 起点(整体跨过)。 */
function snapLeft(text: string, pos: number): number {
  for (const s of spans(text)) if (pos > s.start && pos < s.end) return s.start
  return pos
}

/** 右移落点在 span 内 → 吸到 span 终点(整体跨过)。 */
function snapRight(text: string, pos: number): number {
  for (const s of spans(text)) if (pos > s.start && pos < s.end) return s.end
  return pos
}

/** 对 buf.cursor 执行 snapOut,避免光标停留在 span 内部。 */
function snapBuf(buf: TextBuffer): TextBuffer {
  return { ...buf, cursor: snapOut(buf.text, buf.cursor) }
}

/** 剪除不再被任何 span 引用的 pastes 项,保持 Map 与文本同步。 */
function prune(text: string, pastes: PasteMap): Map<number, string> {
  const referenced = new Set(spans(text).map((s) => s.id))
  const out = new Map<number, string>()
  for (const [id, c] of pastes) if (referenced.has(id)) out.set(id, c)
  return out
}

/** 退格:光标紧跟 span END 则整块删,否则普通退格。 */
function atomicBackspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor > 0 && buf.text[buf.cursor - 1] === PASTE_END) {
    const s = spans(buf.text).find((s) => s.end === buf.cursor)
    if (s) return { text: buf.text.slice(0, s.start) + buf.text.slice(s.end), cursor: s.start }
  }
  return backspace(buf)
}

/** 向后删:光标正处 span START 则整块删,否则普通向后删。 */
function atomicDelete(buf: TextBuffer): TextBuffer {
  if (buf.text[buf.cursor] === PASTE_START) {
    const s = spans(buf.text).find((s) => s.start === buf.cursor)
    if (s) return { text: buf.text.slice(0, s.start) + buf.text.slice(s.end), cursor: s.start }
  }
  return deleteForward(buf)
}

/** 占位符感知地应用一个编辑事件,返回新 buf 与新 pastes(span 被删则剪除其 id)。 */
export function pasteReduce(
  buf: TextBuffer,
  pastes: PasteMap,
  ev: InputEvent,
): { buf: TextBuffer; pastes: Map<number, string> } {
  let next: TextBuffer
  switch (ev.type) {
    case 'insert':
      next = insert(buf, ev.text)
      break
    case 'newline':
      next = insert(buf, '\n')
      break
    case 'backspace':
      next = atomicBackspace(buf)
      break
    case 'delete':
      next = atomicDelete(buf)
      break
    case 'left':
      next = { ...buf, cursor: snapLeft(buf.text, Math.max(0, buf.cursor - 1)) }
      break
    case 'right':
      next = { ...buf, cursor: snapRight(buf.text, Math.min(buf.text.length, buf.cursor + 1)) }
      break
    case 'up':
      next = snapBuf(moveUp(buf))
      break
    case 'down':
      next = snapBuf(moveDown(buf))
      break
    case 'home':
      next = snapBuf(moveHome(buf))
      break
    case 'end':
      next = snapBuf(moveEnd(buf))
      break
    case 'pageUp':
      next = snapBuf(moveBufferStart(buf))
      break
    case 'pageDown':
      next = snapBuf(moveBufferEnd(buf))
      break
    case 'submit':
    case 'none':
      next = reduce(buf, ev)
      break
  }
  return { buf: next, pastes: prune(next.text, pastes) }
}
