import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import type { UIMessage, UIToolCall } from '../types.js'

interface StreamRendererProps {
  message: UIMessage
}

/** 把一个工具的参数压成一行摘要，例如 Read(src/index.ts)。 */
function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.file_path === 'string') return obj.file_path
    const json = JSON.stringify(obj)
    return json.length > 60 ? json.slice(0, 60) + '…' : json
  }
  return ''
}

function ToolBlock({ tool }: { tool: UIToolCall }) {
  const marker =
    tool.status === 'running' ? (
      <Spinner />
    ) : (
      <Text color={tool.isError ? 'red' : 'green'}>{tool.isError ? '✗' : '✓'}</Text>
    )

  // 取输出的第一行作为紧凑的预览。
  const preview = tool.output ? (tool.output.split('\n')[0]?.slice(0, 80) ?? '') : ''

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>{marker}</Box>
      <Box flexDirection="column">
        <Text color="cyan">
          {tool.name}
          <Text dimColor>({summarizeInput(tool.input)})</Text>
        </Text>
        {tool.status === 'done' && preview && (
          <Text dimColor>
            {tool.isError ? '错误：' : ''}
            {preview}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export function StreamRenderer({ message }: StreamRendererProps) {
  // 工具调用：一行青色的 "Name(args)"，带状态标记 + 结果预览。
  if (message.role === 'tool' && message.tool) {
    return <ToolBlock tool={message.tool} />
  }

  // system 消息是本地通知（斜杠命令输出）：暗色、无边框。
  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>{message.text}</Text>
      </Box>
    )
  }

  // user 消息用一个方框框起来。
  if (message.role === 'user') {
    return (
      <Box marginBottom={1} borderStyle="round" borderColor="green" paddingX={1}>
        <Text>{message.text}</Text>
      </Box>
    )
  }

  // 没有产生任何文本的助手回合（例如纯工具调用）什么都不渲染
  // —— 可见内容由工具块来承载。
  if (!message.isStreaming && message.text === '') {
    return null
  }

  // 助手：标记单独占一列，这样换行后的文本能对齐在文字下方
  //（悬挂缩进）。流式期间标记是个 spinner；完成后定格成一个静态圆点。
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>{message.isStreaming ? <Spinner /> : <Text color="yellow">●</Text>}</Box>
      <Box flexDirection="column">
        <Text>{message.text}</Text>
        {message.usage && (
          <Text dimColor>
            输入 {message.usage.input_tokens} · 输出 {message.usage.output_tokens} tokens
          </Text>
        )}
      </Box>
    </Box>
  )
}
