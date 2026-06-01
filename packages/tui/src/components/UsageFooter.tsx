import { Box, Text } from 'ink'
import type { Usage } from '@zuse/core'

/**
 * Soft warning threshold for the live context size (fault mode ②). Past this,
 * `ctx` turns yellow as a nudge to /clear or /save — not a hard cap.
 */
const CONTEXT_SOFT_LIMIT = 100_000

interface UsageFooterProps {
  model: string
  totalUsage?: Usage
  contextTokens?: number  // last turn's input_tokens — the live context size
  isThinking: boolean
}

export function UsageFooter({ model, totalUsage, contextTokens, isThinking }: UsageFooterProps) {
  const ctxColor = contextTokens !== undefined && contextTokens >= CONTEXT_SOFT_LIMIT ? 'yellow' : undefined

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>Model: {model}</Text>
      <Text dimColor> | </Text>
      {totalUsage ? (
        <Text dimColor>
          Total: {totalUsage.input_tokens + totalUsage.output_tokens} tokens
        </Text>
      ) : (
        <Text dimColor>No tokens yet</Text>
      )}
      {contextTokens !== undefined && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor color={ctxColor}>ctx: {contextTokens}</Text>
        </>
      )}
      {isThinking && (
        <Text dimColor color="yellow">
          {' | '}Thinking...
        </Text>
      )}
    </Box>
  )
}
