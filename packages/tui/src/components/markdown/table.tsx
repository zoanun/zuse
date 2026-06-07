import { Box, Text } from 'ink'
import type { Tokens } from 'marked'
import {
  computeColumnWidths,
  buildBorderLine,
  buildRowLines,
  decodeEntities,
  type CellAlign,
} from './layout.js'

interface TableProps {
  token: Tokens.Table
}

/** GFM 表格:手绘 box-drawing 网格,列宽与 CJK 宽度由 layout 纯函数算好。 */
export function Table({ token }: TableProps) {
  const aligns: CellAlign[] = token.align.map((a) => a ?? 'left')
  const headerCells = token.header.map((cell) => decodeEntities(cell.text))
  const bodyRows = token.rows.map((row) => row.map((cell) => decodeEntities(cell.text)))
  // 终端可用宽度;取不到(管道/重定向)按 80 算,再留 2 列边距。
  const maxWidth = (process.stdout.columns ?? 80) - 2
  const widths = computeColumnWidths([headerCells, ...bodyRows], maxWidth)

  const headerLines = buildRowLines(headerCells, widths, aligns)
  const bodyLineGroups = bodyRows.map((row) => buildRowLines(row, widths, aligns))

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{buildBorderLine(widths, 'top')}</Text>
      {headerLines.map((line, i) => (
        <Text key={`h-${i}`} bold>
          {line}
        </Text>
      ))}
      <Text>{buildBorderLine(widths, 'mid')}</Text>
      {bodyLineGroups.map((lines, r) =>
        lines.map((line, i) => <Text key={`b-${r}-${i}`}>{line}</Text>),
      )}
      <Text>{buildBorderLine(widths, 'bottom')}</Text>
    </Box>
  )
}
