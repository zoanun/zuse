import { Box, Text } from 'ink'
import type { UIMessage } from '../types.js'

interface StreamRendererProps {
  message: UIMessage
}

export function StreamRenderer({ message }: StreamRendererProps) {
  const color = message.role === 'user' ? 'green' : 'yellow'
  const prefix = message.role === 'user' ? 'You: ' : 'Assistant: '

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={color}>
          {prefix}
        </Text>
        <Text>{message.text}</Text>
        {message.isStreaming && <Text color="gray">█</Text>}
      </Box>
      {message.role === 'assistant' && message.usage && (
        <Text dimColor>
          Tokens: {message.usage.input_tokens} in / {message.usage.output_tokens} out
        </Text>
      )}
    </Box>
  )
}