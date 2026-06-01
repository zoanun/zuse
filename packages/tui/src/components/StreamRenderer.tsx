import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import type { UIMessage } from '../types.js'

interface StreamRendererProps {
  message: UIMessage
}

export function StreamRenderer({ message }: StreamRendererProps) {
  // System messages are local notices (slash-command output): dim, unframed.
  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>{message.text}</Text>
      </Box>
    )
  }

  // User messages are framed in a box; assistant replies are marked with a
  // left-side bullet (Claude Code style).
  if (message.role === 'user') {
    return (
      <Box marginBottom={1} borderStyle="round" borderColor="green" paddingX={1}>
        <Text>{message.text}</Text>
      </Box>
    )
  }

  // Assistant: marker in its own column so wrapped lines align under the text
  // (hanging indent) and the gap comes from margin, not a trimmable space.
  // While streaming the marker is a spinner ("thinking"); once done it settles
  // into a static bullet.
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>
        {message.isStreaming ? <Spinner /> : <Text color="yellow">●</Text>}
      </Box>
      <Box flexDirection="column">
        <Text>{message.text}</Text>
        {message.usage && (
          <Text dimColor>
            Tokens: {message.usage.input_tokens} in / {message.usage.output_tokens} out
          </Text>
        )}
      </Box>
    </Box>
  )
}
