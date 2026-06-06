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
      <Text dimColor>Model: {model}</Text>
      <Text dimColor> | </Text>
      {totalUsage ? (
        <Text dimColor>
          {/* input_tokens 已归一为「不含缓存」，故 Total 显式加回缓存读写，否则开缓存时会少计。 */}
          Total:{' '}
          {totalUsage.input_tokens +
            totalUsage.output_tokens +
            (totalUsage.cache_read_input_tokens ?? 0) +
            (totalUsage.cache_creation_input_tokens ?? 0)}{' '}
          tokens
        </Text>
      ) : (
        <Text dimColor>No tokens yet</Text>
      )}
      {contextTokens !== undefined && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor color={ctxColor}>
            ctx: {contextTokens}
          </Text>
        </>
      )}
      {totalUsage && (totalUsage.cache_read_input_tokens ?? 0) > 0 && (
        <Text dimColor>
          {' · cache '}
          {((totalUsage.cache_read_input_tokens ?? 0) / 1000).toFixed(1)}k read
        </Text>
      )}
      {isThinking && (
        <Text dimColor color="yellow">
          {' | '}Thinking...
        </Text>
      )}
    </Box>
  )
}
