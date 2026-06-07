import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import { BLACK_CIRCLE } from './figures.js'
import { summarizeOutput, toolSpecifier } from './toolSummary.js'
import { computeLineDiff, diffStats, capDiff } from './editDiff.js'
import type { ReactElement } from 'react'
import type { UIMessage, UIToolCall } from '../types.js'
import { Markdown } from './markdown/Markdown.js'

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
  // Edit:有可用 old/new 时渲染彩色行级 diff(#2);否则回落到通用摘要。
  if (tool.name === 'Edit' && !tool.isError) {
    const diff = renderEditDiff(tool)
    if (diff) return diff
  }
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

/** Edit 一次替换的处数:从工具 output "Edited X (N replacement(s))." 解析;取不到记 1。 */
function countReplacements(output: string | undefined): number {
  const m = (output ?? '').match(/\((\d+) replacement/)
  return m?.[1] ? Number(m[1]) : 1
}

/**
 * 渲染 Edit 的彩色行级 diff。数据(字符串 old/new)不可用时返回 null,
 * 让 ToolResultLine 回落到 #1 的通用摘要。
 */
function renderEditDiff(tool: UIToolCall): ReactElement | null {
  const input = tool.input as {
    old_string?: unknown
    new_string?: unknown
    file_path?: unknown
    replace_all?: unknown
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null

  const file = typeof input.file_path === 'string' ? input.file_path : ''
  const rows = computeLineDiff(input.old_string, input.new_string)
  const { added, removed } = diffStats(rows)
  const { rows: shown, more } = capDiff(rows, 10)
  // replace_all 多处替换:标题行追加 (×N);+A -R 仍按单 hunk 计。
  const times = countReplacements(tool.output)
  const suffix = input.replace_all === true && times > 1 ? ` (×${times})` : ''

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`  ⎿ Updated ${file}  `}
        <Text color="green">{`+${added}`}</Text>
        {' '}
        <Text color="red">{`-${removed}`}</Text>
        {suffix}
      </Text>
      {shown.map((r, i) => {
        const prefix = r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '
        const color = r.kind === 'add' ? 'green' : r.kind === 'del' ? 'red' : undefined
        return (
          <Text key={i} color={color} dimColor={r.kind === 'context'}>
            {`    ${prefix}${r.text}`}
          </Text>
        )
      })}
      {more > 0 && <Text dimColor>{`    … +${more} 行`}</Text>}
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
        {/* 流式期间走纯文本(快、稳、不抖);定稿后重渲染成富 Markdown。 */}
        {message.isStreaming ? <Text>{message.text}</Text> : <Markdown source={message.text} />}
        {message.usage && (
          <Text dimColor>
            输入 {message.usage.input_tokens} · 输出 {message.usage.output_tokens} tokens
          </Text>
        )}
      </Box>
    </Box>
  )
}
