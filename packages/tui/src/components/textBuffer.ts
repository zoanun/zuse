/**
 * 多行输入框的纯文本模型：一段文本 + 一个光标偏移。
 * 所有编辑操作都是纯函数（返回新对象），便于单测；Ink 组件只做事件分发与渲染。
 */
export interface TextBuffer {
  /** 完整文本，含换行符 `\n`。 */
  readonly text: string
  /** 光标偏移，取值 0..text.length（落在某字符之前）。 */
  readonly cursor: number
}

export const emptyBuffer: TextBuffer = { text: '', cursor: 0 }

/**
 * 编辑事件（由按键映射 inputKeymap 产生，由 reduce 消费）。
 * submit / none 不改动缓冲，交给组件层处理（提交或忽略）。
 */
export type InputEvent =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'submit' }
  | { type: 'none' }

/** 渲染时一行被光标切成的三段；hasCursor 行用反显展示 cursor 字符。 */
export interface RenderLine {
  before: string
  cursor: string
  after: string
  hasCursor: boolean
}

/** 在光标处插入字符串（支持多字符粘贴），光标移到插入内容之后。 */
export function insert(buf: TextBuffer, str: string): TextBuffer {
  const text = buf.text.slice(0, buf.cursor) + str + buf.text.slice(buf.cursor)
  return { text, cursor: buf.cursor + str.length }
}

/** 删除光标前一个字符；光标在开头时为空操作。 */
export function backspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) return buf
  const text = buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor)
  return { text, cursor: buf.cursor - 1 }
}

/** 把光标偏移换算成 { row, col }（col 是行内列，0 起）。 */
function cursorToRowCol(text: string, cursor: number): { row: number; col: number } {
  let row = 0
  let lineStart = 0
  for (let i = 0; i < cursor; i++) {
    if (text[i] === '\n') {
      row++
      lineStart = i + 1
    }
  }
  return { row, col: cursor - lineStart }
}

/** 取各行内容（不含换行符）。空文本返回 ['']，保证至少有一行。 */
function lines(text: string): string[] {
  return text.split('\n')
}

/** 把 { row, col } 换算回光标偏移；col 会被夹到目标行长度内。 */
function rowColToCursor(text: string, row: number, col: number): number {
  const ls = lines(text)
  const clampedRow = Math.max(0, Math.min(row, ls.length - 1))
  let offset = 0
  for (let i = 0; i < clampedRow; i++) {
    offset += (ls[i]?.length ?? 0) + 1 // +1 为换行符
  }
  return offset + Math.min(col, ls[clampedRow]?.length ?? 0)
}

/** 左移一个字符（跨换行符照常逐偏移走）；到开头停住。 */
export function moveLeft(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) return buf
  return { ...buf, cursor: buf.cursor - 1 }
}

/** 右移一个字符；到末尾停住。 */
export function moveRight(buf: TextBuffer): TextBuffer {
  if (buf.cursor >= buf.text.length) return buf
  return { ...buf, cursor: buf.cursor + 1 }
}

/** 上移一行，保持列；已在首行则移到缓冲开头。 */
export function moveUp(buf: TextBuffer): TextBuffer {
  const { row, col } = cursorToRowCol(buf.text, buf.cursor)
  if (row === 0) return { ...buf, cursor: 0 }
  return { ...buf, cursor: rowColToCursor(buf.text, row - 1, col) }
}

/** 下移一行，保持列；已在末行则移到缓冲结尾。 */
export function moveDown(buf: TextBuffer): TextBuffer {
  const { row, col } = cursorToRowCol(buf.text, buf.cursor)
  if (row === lines(buf.text).length - 1) return { ...buf, cursor: buf.text.length }
  return { ...buf, cursor: rowColToCursor(buf.text, row + 1, col) }
}

/** 移到当前行起点。 */
export function moveHome(buf: TextBuffer): TextBuffer {
  const { row } = cursorToRowCol(buf.text, buf.cursor)
  return { ...buf, cursor: rowColToCursor(buf.text, row, 0) }
}

/** 移到当前行终点。 */
export function moveEnd(buf: TextBuffer): TextBuffer {
  const { row } = cursorToRowCol(buf.text, buf.cursor)
  const lineLen = lines(buf.text)[row]?.length ?? 0
  return { ...buf, cursor: rowColToCursor(buf.text, row, lineLen) }
}

/** 把一个编辑事件应用到缓冲；submit / none 原样返回。 */
export function reduce(buf: TextBuffer, ev: InputEvent): TextBuffer {
  switch (ev.type) {
    case 'insert':
      return insert(buf, ev.text)
    case 'newline':
      return insert(buf, '\n')
    case 'backspace':
      return backspace(buf)
    case 'left':
      return moveLeft(buf)
    case 'right':
      return moveRight(buf)
    case 'up':
      return moveUp(buf)
    case 'down':
      return moveDown(buf)
    case 'home':
      return moveHome(buf)
    case 'end':
      return moveEnd(buf)
    case 'submit':
    case 'none':
      return buf
  }
}

/** 输入框的可视窗口：行数超过上限时按光标行开窗，保证光标始终可见。 */
export interface InputViewport {
  /** 可视行切片（长度 = min(总行数, maxRows)）。 */
  lines: RenderLine[]
  /** 窗口上方被裁掉的行数（>0 时提示「还有 N 行」）。 */
  hiddenAbove: number
  /** 窗口下方被裁掉的行数。 */
  hiddenBelow: number
}

/**
 * 把渲染行裁剪到至多 maxRows 行，避免输入框无限增高把整屏输出顶过终端高度
 *（那会触发 Ink 的重绘错位，表现为「上面一行不见了」）。
 * 以光标行作为窗口底向上开窗（编辑通常在末尾）；光标上移到窗口之上时，
 * start 自然回落到 0 一侧，保证光标行恒在可视窗口内。maxRows<=0 视为不开窗。
 */
export function viewport(buf: TextBuffer, maxRows: number): InputViewport {
  const all = splitForRender(buf)
  if (maxRows <= 0 || all.length <= maxRows) {
    return { lines: all, hiddenAbove: 0, hiddenBelow: 0 }
  }
  const cursorRow = all.findIndex((l) => l.hasCursor)
  const row = cursorRow < 0 ? all.length - 1 : cursorRow
  const start = Math.max(0, Math.min(row - maxRows + 1, all.length - maxRows))
  const end = start + maxRows
  return { lines: all.slice(start, end), hiddenAbove: start, hiddenBelow: all.length - end }
}

/** 按行切分文本，并在光标所在行标出三段，供组件用反显渲染光标。 */
export function splitForRender(buf: TextBuffer): RenderLine[] {
  const { row, col } = cursorToRowCol(buf.text, buf.cursor)
  return lines(buf.text).map((line, i) => {
    if (i !== row) return { before: line, cursor: '', after: '', hasCursor: false }
    return {
      before: line.slice(0, col),
      // 光标落在行尾（col === 行长）时没有字符可反显，用空格当光标块。
      cursor: line[col] ?? ' ',
      after: line.slice(col + 1),
      hasCursor: true,
    }
  })
}
