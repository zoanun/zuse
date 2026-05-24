import { Box } from 'ink'
import { StreamRenderer } from './StreamRenderer.js'
import type { UIMessage } from '../types.js'

interface MessageListProps {
  messages: UIMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg) => (
        <StreamRenderer key={msg.id} message={msg} />
      ))}
    </Box>
  )
}