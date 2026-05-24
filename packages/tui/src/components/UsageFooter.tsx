import { Box, Text } from 'ink'
import type { Usage } from '@zuse/core'

interface UsageFooterProps {
  model: string
  totalUsage?: Usage
  isThinking: boolean
}

export function UsageFooter({ model, totalUsage, isThinking }: UsageFooterProps) {
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
      {isThinking && (
        <Text dimColor color="yellow">
          {' | '}Thinking...
        </Text>
      )}
    </Box>
  )
}