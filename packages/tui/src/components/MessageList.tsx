import { Box } from 'ink'
import { StreamRenderer, MSG_PAD_X } from './StreamRenderer.js'
import type { UIMessage } from '../types.js'

interface MessageListProps {
  messages: UIMessage[]
  /** 透传给 StreamRenderer:用于把 Glob/Grep 相对路径拼成可点击的绝对路径链接。 */
  cwd: string
}

export function MessageList({ messages, cwd }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" paddingX={MSG_PAD_X}>
      {messages.map((msg) => (
        <StreamRenderer key={msg.id} message={msg} cwd={cwd} />
      ))}
    </Box>
  )
}
