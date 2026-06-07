import { Box, Text } from 'ink'
import type { Usage } from '@zuse/core'

/**
 * 实时上下文大小的软警戒线（故障模式②）。超过它之后，`上下文` 会变黄，
 * 提示去 /clear 或 /save —— 这不是硬上限。
 */
const CONTEXT_SOFT_LIMIT = 100_000

interface UsageFooterProps {
  totalUsage?: Usage
  contextTokens?: number // 上一回合的完整输入规模（新输入 + 缓存命中）—— 实时上下文大小
  isThinking: boolean
}

/**
 * 用量页脚：无边框，紧贴输入框下方靠右显示（见 App 布局）。不再展示模型——
 * 模型在启动横幅里已给出，页脚只留实时的用量/上下文/缓存命中。
 * 分隔符用 ` · `，各段缺省时整段省略，避免出现空悬的分隔符。
 */
export function UsageFooter({ totalUsage, contextTokens, isThinking }: UsageFooterProps) {
  const ctxColor =
    contextTokens !== undefined && contextTokens >= CONTEXT_SOFT_LIMIT ? 'yellow' : undefined

  // input_tokens 已归一为「不含缓存」，故累计显式加回缓存读写，否则开缓存时会少计。
  const total =
    totalUsage &&
    totalUsage.input_tokens +
      totalUsage.output_tokens +
      (totalUsage.cache_read_input_tokens ?? 0) +
      (totalUsage.cache_creation_input_tokens ?? 0)

  const cacheHit = (totalUsage?.cache_read_input_tokens ?? 0) > 0

  return (
    <Box justifyContent="flex-end" paddingX={1}>
      {total !== undefined && <Text dimColor>累计 {total} tokens</Text>}
      {contextTokens !== undefined && (
        <>
          {total !== undefined && <Text dimColor> · </Text>}
          <Text dimColor color={ctxColor}>
            上下文 {contextTokens}
          </Text>
        </>
      )}
      {cacheHit && (
        <Text dimColor>
          {' · 缓存命中 '}
          {((totalUsage?.cache_read_input_tokens ?? 0) / 1000).toFixed(1)}k
        </Text>
      )}
      {isThinking && (
        <Text dimColor color="yellow">
          {' · '}思考中…
        </Text>
      )}
    </Box>
  )
}
