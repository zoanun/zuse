import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import { BLACK_CIRCLE } from './figures.js'
import { summarizeOutput, toolSpecifier } from './toolSummary.js'
import type { UIMessage, UIToolCall } from '../types.js'

interface StreamRendererProps {
  message: UIMessage
}


function ToolBlock({ tool }: { tool: UIToolCall }) {
  // 标记列:运行中 spinner(青);完成 ●(绿);出错 ●(红)。独占一列,悬挂缩进。
  const marker =
    tool.status === 'running' ? (
      <Spinner />
    ) : (
      <Text color={tool.isError ? 'red' : 'green'}>{BLACK_CIRCLE}</Text>
    )

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>{marker}</Box>
      <Box flexDirection="column">
        <Text color="cyan">
          {tool.name}
          <Text dimColor>({toolSpecifier(tool.name, tool.input)})</Text>
        </Text>
        {tool.status === 'done' && <ToolResultLine tool={tool} />}
      </Box>
    </Box>
  )
}

/** `⎿` 结果区:按 summarizeOutput 的判别联合渲染单行 / 多行预览 / 错误行。 */
function ToolResultLine({ tool }: { tool: UIToolCall }) {
  const summary = summarizeOutput(tool)
  if (summary.kind === 'error') {
    return <Text color="red">{`  ⎿ ${summary.text}`}</Text>
  }
  if (summary.kind === 'line') {
    // line 类不会来自错误(错误走 error/preview),恒为暗色。
    return <Text dimColor>{`  ⎿ ${summary.text}`}</Text>
  }
  // preview:首行带 ⎿,续行对齐到内容列(5 空格);Bash 类错误时整体着红,否则暗色。
  const color = tool.isError ? 'red' : undefined
  return (
    <Box flexDirection="column">
      {summary.lines.map((line, i) => (
        <Text key={i} color={color} dimColor={!tool.isError}>
          {i === 0 ? `  ⎿ ${line}` : `     ${line}`}
        </Text>
      ))}
      {summary.moreCount > 0 && <Text dimColor>{`     … +${summary.moreCount} 行`}</Text>}
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
