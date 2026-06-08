import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { Tokens } from 'marked'
import { computeColumnWidths, type CellAlign } from './layout.js'
import { inlineSpans, wrapSpans, padSpans, spansToPlainText, type StyledSpan } from './spans.js'
import { renderSpan } from './inline.js'

interface TableProps {
  token: Tokens.Table
}

/** 把一物理行的各列(已折行+补白的片段)拼成 `│ c0 │ c1 │`,bold 时整行加粗(表头)。 */
function renderRowLine(cells: StyledSpan[][], key: string, bold: boolean): ReactNode {
  const children: ReactNode[] = ['│']
  cells.forEach((spans, c) => {
    children.push(' ')
    spans.forEach((s, i) => children.push(renderSpan(s, `${key}-c${c}-s${i}`)))
    children.push(' ', '│')
  })
  return (
    <Text key={key} bold={bold}>
      {children}
    </Text>
  )
}

/** GFM 表格:手绘 box-drawing 网格;单元格内行内 Markdown 经 spans 排版后保留样式。 */
export function Table({ token }: TableProps) {
  const aligns: CellAlign[] = token.align.map((a) => a ?? 'left')
  // 每个单元格先拍平成样式片段(<br> 在格内呈现为空格,避免撑破网格)。
  const headerCells = token.header.map((cell) => inlineSpans(cell.tokens))
  const bodyCells = token.rows.map((row) => row.map((cell) => inlineSpans(cell.tokens)))
  // 终端可用宽度;取不到(管道/重定向)按 80 算,再留 2 列边距。
  const maxWidth = (process.stdout.columns ?? 80) - 2
  // 列宽按各单元格纯文本宽度算——片段文本已含 codespan 两侧空格,与渲染逐字符对应。
  const widths = computeColumnWidths(
    [headerCells, ...bodyCells].map((row) => row.map(spansToPlainText)),
    maxWidth,
  )

  // 一行可能折成多物理行:各列分别折行,取最大行数,逐物理行补白后拼装。
  const renderRow = (cells: StyledSpan[][], rowKey: string, bold: boolean): ReactNode[] => {
    const wrapped = cells.map((spans, c) => wrapSpans(spans, widths[c] ?? 0))
    const height = Math.max(1, ...wrapped.map((w) => w.length))
    const lines: ReactNode[] = []
    for (let r = 0; r < height; r++) {
      const lineCells = widths.map((w, c) => padSpans(wrapped[c]?.[r] ?? [], w, aligns[c] ?? 'left'))
      lines.push(renderRowLine(lineCells, `${rowKey}-l${r}`, bold))
    }
    return lines
  }

  // 抗缩放:不画 ┌┬┐ / ├┼┤ / └┴┘ 网格——带 junction 的横线一旦随消息打进 <Static> 冻结,
  // 终端缩放重排时会与各行的 │ 错位拆碎(与横幅/输入框/代码块同病)。改为只保留行内 │ 列
  // 分隔(各在单行内,换行随内容流动、不拆),表头与表体之间用一条纯 ─ 横线分隔(无 junction,
  // 缩放至多换成两行短横、不拆)。横线宽度对齐行宽 = Σ(列宽+3) + 1(首列前的 │ 与各列后的「 │」)。
  const ruleWidth = widths.reduce((sum, w) => sum + w + 3, 0) + 1
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderRow(headerCells, 'h', true)}
      <Text dimColor>{'─'.repeat(Math.max(1, ruleWidth))}</Text>
      {bodyCells.map((cells, r) => renderRow(cells, `b${r}`, false))}
    </Box>
  )
}
