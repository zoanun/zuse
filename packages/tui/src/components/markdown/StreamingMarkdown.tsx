import { Text } from 'ink'
import { marked } from 'marked'
import type { Token } from 'marked'
import { useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderBlocks } from './blocks.js'

interface PrefixCache {
  raw: string
  nodes: ReactNode[]
}

/**
 * 流式期间的 Markdown 增量渲染:已被后续内容封口的块(稳定前缀)走富渲染,
 * 最后一个可能未完成的块保持纯文本。每帧全文重新 lexer,切分偏差下一帧自动纠正;
 * 定稿后 StreamRenderer 会换用 <Markdown> 整体重渲染兜底。
 */
export function StreamingMarkdown({ source }: { source: string }): ReactElement | null {
  // 按前缀 raw 缓存已渲染节点:前缀只在「新块封口」时变化,绝大多数帧直接复用。
  const cache = useRef<PrefixCache>({ raw: '', nodes: [] })
  if (source === '') return null

  let tokens: Token[]
  try {
    tokens = marked.lexer(source, { gfm: true, breaks: false })
  } catch {
    return <Text>{source}</Text>
  }

  // 尾 token 是 space(≥2 个连续换行)说明所有块都已封口;
  // 否则最后一个块视为生成中(单个 \n 后仍可能被续写,如表格加行)。
  const last = tokens[tokens.length - 1]
  const sealed = last !== undefined && last.type === 'space'
  const prefix = sealed ? tokens : tokens.slice(0, -1)
  if (prefix.length === 0) return <Text>{source}</Text>

  const prefixRaw = prefix.map((t) => t.raw).join('')
  try {
    if (prefixRaw !== cache.current.raw) {
      cache.current = { raw: prefixRaw, nodes: renderBlocks(prefix) }
    }
  } catch {
    return <Text>{source}</Text>
  }
  return (
    <>
      {cache.current.nodes}
      {!sealed && last != null && <Text>{last.raw}</Text>}
    </>
  )
}
