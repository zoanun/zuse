import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { Token } from 'marked'
import { inlineSpans, type StyledSpan } from './spans.js'

/** 把一个样式片段渲染成 <Text>。表格与段落共用,保证两处行内样式一致。 */
export function renderSpan(span: StyledSpan, key: string): ReactNode {
  return (
    <Text
      key={key}
      bold={span.bold}
      italic={span.italic}
      strikethrough={span.strikethrough}
      underline={span.underline}
      color={span.color}
      backgroundColor={span.backgroundColor}
      dimColor={span.dimColor}
    >
      {span.text}
    </Text>
  )
}

/**
 * 把 marked 行内 token 渲染成 <Text> 列表。样式映射统一在 spans.ts 的 inlineSpans 里,
 * 段落场景把软换行 <br> 还原成真正的换行('\n')。
 */
export function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  return inlineSpans(tokens, '\n').map((span, i) => renderSpan(span, `${keyPrefix}-i${i}`))
}
