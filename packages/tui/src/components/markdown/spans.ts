import type { Token, Tokens } from 'marked'
import { displayWidth, wrapCell, decodeEntities, type CellAlign } from './layout.js'

/**
 * 一段同样式的行内文本。字段对应 Ink <Text> 的属性,渲染时直接铺开。
 * 表格单元格里也要显示行内 Markdown(代码/粗体/链接 等),但表格是定宽网格,
 * 只能按显示宽度排版:先把行内 token 拍平成「带样式的纯文本片段」,
 * 用纯文本算宽度/折行/补白,再连同竖线罫线一起渲染成带样式的 <Text>。
 */
export interface StyledSpan {
  text: string
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  color?: string
  backgroundColor?: string
  dimColor?: boolean
}

/** span 的样式部分(去掉 text)。 */
export type SpanStyle = Omit<StyledSpan, 'text'>

function styleOf(span: StyledSpan): SpanStyle {
  const { text: _text, ...rest } = span
  return rest
}

function sameStyle(a: StyledSpan, b: SpanStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.underline === b.underline &&
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.dimColor === b.dimColor
  )
}

/**
 * 把 marked 行内 token 拍平成样式片段。视觉映射与 inline.tsx 的 renderInline 完全一致
 * (codespan 两侧补空格 + 灰底白字;链接下划线蓝字 + 暗色 (url)),两边由本函数统一负责。
 * breakAs:软换行 <br> 的呈现——段落里用 '\n' 保留换行,表格单元格里用 ' ' 以免撑破网格。
 */
export function inlineSpans(tokens: Token[], breakAs = ' ', inherited: SpanStyle = {}): StyledSpan[] {
  const out: StyledSpan[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
        out.push(...inlineSpans((tok as Tokens.Strong).tokens, breakAs, { ...inherited, bold: true }))
        break
      case 'em':
        out.push(...inlineSpans((tok as Tokens.Em).tokens, breakAs, { ...inherited, italic: true }))
        break
      case 'del':
        out.push(
          ...inlineSpans((tok as Tokens.Del).tokens, breakAs, { ...inherited, strikethrough: true }),
        )
        break
      case 'codespan':
        out.push({
          ...inherited,
          text: ` ${decodeEntities((tok as Tokens.Codespan).text)} `,
          backgroundColor: 'gray',
          color: 'white',
        })
        break
      case 'link': {
        const link = tok as Tokens.Link
        out.push(...inlineSpans(link.tokens, breakAs, { ...inherited, underline: true, color: 'blue' }))
        out.push({ ...inherited, text: ` (${link.href})`, dimColor: true })
        break
      }
      case 'br':
        out.push({ ...inherited, text: breakAs })
        break
      default: {
        // text / escape / 其它:有嵌套就递归,否则解码后输出纯文本。
        const t = tok as Tokens.Text
        if (t.tokens && t.tokens.length > 0) out.push(...inlineSpans(t.tokens, breakAs, inherited))
        else out.push({ ...inherited, text: decodeEntities(t.text ?? tok.raw ?? '') })
      }
    }
  }
  return out
}

/** 拼接所有片段的纯文本——用于算列宽,与渲染出的可见文本逐字符对应。 */
export function spansToPlainText(spans: StyledSpan[]): string {
  return spans.map((s) => s.text).join('')
}

/** 片段序列的显示宽度。 */
export function spansWidth(spans: StyledSpan[]): number {
  return displayWidth(spansToPlainText(spans))
}

/** 对齐补白要补的左右空格数。pad<=0(文本已够宽)时不补。 */
export function padCounts(
  curWidth: number,
  width: number,
  align: CellAlign,
): { left: number; right: number } {
  const pad = width - curWidth
  if (pad <= 0) return { left: 0, right: 0 }
  if (align === 'right') return { left: pad, right: 0 }
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return { left, right: pad - left }
  }
  return { left: 0, right: pad }
}

/** 把一行片段按对齐补白到定宽;空格作为无样式片段加在两端。 */
export function padSpans(line: StyledSpan[], width: number, align: CellAlign): StyledSpan[] {
  const { left, right } = padCounts(spansWidth(line), width, align)
  const out = [...line]
  if (left > 0) out.unshift({ text: ' '.repeat(left) })
  if (right > 0) out.push({ text: ' '.repeat(right) })
  return out
}

/** 把连续同样式的码点合并回片段。 */
function coalesce(chars: { ch: string; style: SpanStyle }[]): StyledSpan[] {
  const out: StyledSpan[] = []
  for (const { ch, style } of chars) {
    const last = out[out.length - 1]
    if (last && sameStyle(last, style)) last.text += ch
    else out.push({ ...style, text: ch })
  }
  return out
}

/**
 * 按显示宽度折行,保留每个码点的样式。折行位置复用 wrapCell(对纯文本算),
 * 因此与纯文本表格的折行完全一致,补白后列对齐不会错位。
 */
export function wrapSpans(spans: StyledSpan[], width: number): StyledSpan[][] {
  const lines = wrapCell(spansToPlainText(spans), width)
  // 展开成带样式的码点序列(顺序与 spansToPlainText 完全一致)。
  const chars: { ch: string; style: SpanStyle }[] = []
  for (const span of spans) {
    const style = styleOf(span)
    for (const ch of span.text) chars.push({ ch, style })
  }
  const result: StyledSpan[][] = []
  let idx = 0
  for (const line of lines) {
    const count = [...line].length
    result.push(coalesce(chars.slice(idx, idx + count)))
    idx += count
  }
  return result
}
