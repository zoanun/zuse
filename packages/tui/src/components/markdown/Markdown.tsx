import { Text } from 'ink'
import { marked } from 'marked'
import type { ReactElement } from 'react'
import { renderBlocks } from './blocks.js'

interface MarkdownProps {
  source: string
}

/** 把一段已定稿的 Markdown 渲染成终端富文本;解析失败时整体回退纯文本。 */
export function Markdown({ source }: MarkdownProps): ReactElement | null {
  if (source === '') return null
  try {
    const tokens = marked.lexer(source, { gfm: true, breaks: false })
    return <>{renderBlocks(tokens)}</>
  } catch {
    return <Text>{source}</Text>
  }
}
