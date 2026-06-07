import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { renderInline } from './inline.js'
import { Table } from './table.js'
import { decodeEntities, listPrefix } from './layout.js'

/** 标题按层级着色:H1–H2 青,H3–H4 蓝,H5–H6 白。 */
function headingColor(depth: number): string {
  if (depth <= 2) return 'cyan'
  if (depth <= 4) return 'blue'
  return 'white'
}

/** 把 marked 块级 token 数组映射成 Ink 组件;未知类型回退其 raw 文本。 */
export function renderBlocks(tokens: Token[]): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `b-${i}`
    switch (tok.type) {
      case 'heading': {
        const h = tok as Tokens.Heading
        return (
          <Box key={key} marginBottom={1}>
            <Text bold color={headingColor(h.depth)}>
              {renderInline(h.tokens, key)}
            </Text>
          </Box>
        )
      }
      case 'paragraph': {
        const p = tok as Tokens.Paragraph
        return (
          <Box key={key} marginBottom={1}>
            <Text>{renderInline(p.tokens, key)}</Text>
          </Box>
        )
      }
      case 'text': {
        // 紧凑列表项的内容是 text token:有嵌套行内就递归,否则解码纯文本。
        const t = tok as Tokens.Text
        return (
          <Text key={key}>
            {t.tokens ? renderInline(t.tokens, key) : decodeEntities(t.text)}
          </Text>
        )
      }
      case 'code': {
        const c = tok as Tokens.Code
        return (
          <Box
            key={key}
            flexDirection="column"
            marginBottom={1}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            {c.lang ? <Text dimColor>{c.lang}</Text> : null}
            <Text>{c.text}</Text>
          </Box>
        )
      }
      case 'blockquote': {
        const bq = tok as Tokens.Blockquote
        return (
          <Box key={key} flexDirection="row" marginBottom={1}>
            <Text color="gray">│ </Text>
            <Box flexDirection="column">{renderBlocks(bq.tokens)}</Box>
          </Box>
        )
      }
      case 'list': {
        const l = tok as Tokens.List
        const start = typeof l.start === 'number' ? l.start : 1
        return (
          <Box key={key} flexDirection="column" marginBottom={1}>
            {l.items.map((item, idx) => (
              <Box key={`${key}-${idx}`} flexDirection="row">
                <Text>{listPrefix(l.ordered, idx, start)}</Text>
                <Box flexDirection="column">{renderBlocks(item.tokens)}</Box>
              </Box>
            ))}
          </Box>
        )
      }
      case 'hr':
        return (
          <Box key={key} marginBottom={1}>
            <Text dimColor>{'─'.repeat((process.stdout.columns ?? 80) - 2)}</Text>
          </Box>
        )
      case 'table':
        return <Table key={key} token={tok as Tokens.Table} />
      case 'space':
        return null
      default:
        return <Text key={key}>{tok.raw}</Text>
    }
  })
}
