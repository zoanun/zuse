import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import { BLACK_CIRCLE, L_CORNER } from './figures.js'
import { summarizeOutput, toolSpecifier } from './toolSummary.js'
import { osc8FileLink } from '../toolOutputFile.js'
import { computeLineDiff, diffStats, capDiff } from './editDiff.js'
import type { ReactElement } from 'react'
import type { UIMessage, UIToolCall } from '../types.js'
import { Markdown } from './markdown/Markdown.js'

interface StreamRendererProps {
  message: UIMessage
}


/** 标题行括号内的参数:Bash 截断后的命令,其余工具的主参数(file_path / pattern / url 等)。 */
function toolHeaderArgs(tool: UIToolCall): string {
  return toolSpecifier(tool.name, tool.input)
}

/**
 * 工具块(仿 cc-haha 紧凑式):
 *   ● Read(/path/to/file)
 *     ⎿ Read 43 lines
 * 标题行 ● + 加粗工具名 + 灰色 (参数);结果摘要挂在下方 ⎿ 行,不再用 IN/OUT 边框盒子。
 */
function ToolBlock({ tool }: { tool: UIToolCall }) {
  // 标记:运行中 spinner(青);完成 ●(绿);出错 ●(红)。
  const marker =
    tool.status === 'running' ? (
      <Spinner />
    ) : (
      <Text color={tool.isError ? 'red' : 'green'}>{BLACK_CIRCLE}</Text>
    )
  const args = toolHeaderArgs(tool)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 标题行:● 工具名(参数) */}
      <Box flexDirection="row">
        <Box marginRight={1}>{marker}</Box>
        <Text>
          <Text bold color="cyan">{tool.name}</Text>
          {args ? <Text dimColor>({args})</Text> : null}
        </Text>
      </Box>
      {/* 结果行:⎿ 摘要;多行(预览 / diff)在 ⎿ 右侧悬挂对齐。 */}
      <Box flexDirection="row">
        <Box marginLeft={2} marginRight={1} flexShrink={0}>
          <Text dimColor>{L_CORNER}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <OutputCell tool={tool} />
        </Box>
      </Box>
    </Box>
  )
}

/** OUT 列内容:运行中显示「运行中…」;完成后按 summarizeOutput 渲染(Edit 走彩色行级 diff)。 */
function OutputCell({ tool }: { tool: UIToolCall }): ReactElement {
  if (tool.status === 'running') {
    return <Text dimColor>运行中…</Text>
  }
  // Edit:有可用 old/new 时渲染彩色行级 diff;否则回落到通用摘要。
  if (tool.name === 'Edit' && !tool.isError) {
    const diff = renderEditDiff(tool)
    if (diff) return diff
  }
  const summary = summarizeOutput(tool)
  if (summary.kind === 'error') {
    return <Text color="red">{summary.text}</Text>
  }
  if (summary.kind === 'line') {
    // line 类不会来自错误(错误走 error/preview),恒为暗色。
    return <Text dimColor>{summary.text}</Text>
  }
  // preview:多行;Bash 类错误时整体着红,否则暗色。
  const color = tool.isError ? 'red' : undefined
  return (
    <Box flexDirection="column">
      {summary.lines.map((line, i) => (
        <Text key={i} color={color} dimColor={!tool.isError}>
          {line}
        </Text>
      ))}
      {summary.moreCount > 0 && <Text dimColor>{`… +${summary.moreCount} 行`}</Text>}
      {/* 完整输出落盘后单独占一行:路径包成 OSC 8 超链接(支持的终端可 ctrl+点击打开,
          不支持的退化为纯文本,路径仍可见可复制)。仅路径部分是链接热区,前缀文字不是。 */}
      {tool.outputFile ? (
        <Text dimColor>{`↗ 完整输出 ${osc8FileLink(tool.outputFile, tool.outputFile)}`}</Text>
      ) : null}
    </Box>
  )
}

/** Edit 一次替换的处数:从工具 output "Edited X (N replacement(s))." 解析;取不到记 1。 */
function countReplacements(output: string | undefined): number {
  const m = (output ?? '').match(/\((\d+) replacement/)
  return m?.[1] ? Number(m[1]) : 1
}

/**
 * 渲染 Edit 的彩色行级 diff(用于 OUT 列)。数据(字符串 old/new)不可用时返回 null,
 * 让 OutputCell 回落到通用摘要。
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
        {`Updated ${file}  `}
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
            {`${prefix}${r.text}`}
          </Text>
        )
      })}
      {more > 0 && <Text dimColor>{`… +${more} 行`}</Text>}
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

  // user 消息:左侧 › 标记 + 浅底色高亮,按内容宽度排版。
  // 关键:不再用「定宽 + 圆角边框」的盒子。已提交消息会被 App 打进 <Static> 滚动区且永不重绘,
  // 一旦用绝对列宽画出带边框的盒子,终端缩放时会按新宽度重新折行,把边框拆碎成乱码(用户反馈的
  // 「一拖拽就变形」)。底色高亮随文字重排——窗口变窄时至多换行,底色仍跟着字走,不会破框。
  if (message.role === 'user') {
    const lines = message.text.split('\n')
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Text key={i} backgroundColor="blackBright" color="whiteBright">
            {`${i === 0 ? '› ' : '  '}${line} `}
          </Text>
        ))}
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
      <Box marginRight={1}>{message.isStreaming ? <Spinner /> : <Text color="green">●</Text>}</Box>
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
