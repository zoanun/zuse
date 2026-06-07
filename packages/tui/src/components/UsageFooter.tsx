import { Box, Text } from 'ink'
import type { Usage } from '@zuse/core'

/**
 * 实时上下文大小的软警戒线（故障模式②）。超过它之后，`ctx` 会变黄，
 * 提示去 /clear 或 /save —— 这不是硬上限。
 */
const CONTEXT_SOFT_LIMIT = 100_000

interface UsageFooterProps {
  model: string
  totalUsage?: Usage
  contextTokens?: number // 上一回合的完整输入规模（新输入 + 缓存命中）—— 实时上下文大小
  isThinking: boolean
}

export function UsageFooter({ model, totalUsage, contextTokens, isThinking }: UsageFooterProps) {
  const ctxColor =
    contextTokens !== undefined && contextTokens >= CONTEXT_SOFT_LIMIT ? 'yellow' : undefined

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>模型 {model}</Text>
      <Text dimColor> | </Text>
      {totalUsage ? (
        <Text dimColor>
          {/* input_tokens 已归一为「不含缓存」，故累计显式加回缓存读写，否则开缓存时会少计。 */}
          累计{' '}
          {totalUsage.input_tokens +
            totalUsage.output_tokens +
            (totalUsage.cache_read_input_tokens ?? 0) +
            (totalUsage.cache_creation_input_tokens ?? 0)}{' '}
          tokens
        </Text>
      ) : (
        <Text dimColor>暂无用量</Text>
      )}
      {contextTokens !== undefined && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor color={ctxColor}>
            上下文 {contextTokens}
          </Text>
        </>
      )}
      {totalUsage && (totalUsage.cache_read_input_tokens ?? 0) > 0 && (
        <Text dimColor>
          {' · 缓存命中 '}
          {((totalUsage.cache_read_input_tokens ?? 0) / 1000).toFixed(1)}k
        </Text>
      )}
      {isThinking && (
        <Text dimColor color="yellow">
          {' | '}思考中…
        </Text>
      )}
    </Box>
  )
}
