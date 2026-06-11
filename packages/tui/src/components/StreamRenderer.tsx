import { Box, Text } from 'ink'
import { resolve } from 'node:path'
import { Spinner } from './Spinner.js'
import { BLACK_CIRCLE, L_CORNER } from './figures.js'
import { summarizeOutput, toolSpecifier, plural } from './toolSummary.js'
import { osc8FileLink } from '../toolOutputFile.js'
import { computeLineDiff, diffStats, capDiff, EDIT_DIFF_CAP } from './editDiff.js'
import { splitPasteLabels } from './pasteLabels.js'
import type { ReactElement } from 'react'
import type { UIMessage, UIToolCall } from '../types.js'
import { Markdown } from './markdown/Markdown.js'

interface StreamRendererProps {
  message: UIMessage
  /** 工作目录:把 Glob/Grep 输出的相对路径拼成绝对路径,才能包成可点击的文件链接。 */
  cwd: string
}


/** 标题行括号内的参数:Bash 截断后的命令,其余工具的主参数(file_path / pattern / url 等)。 */
function toolHeaderArgs(tool: UIToolCall): string {
  return toolSpecifier(tool.name, tool.input)
}

/** 标题路径要做成可点击链接的文件类工具。 */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write'])

/**
 * 文件类工具(Read/Edit/Write)的标题路径包成指向「真实文件」的 OSC 8 链接,点击在编辑器打开
 * 当前磁盘内容(Edit/Write 即改后版本;"改了什么"由下方 inline diff 负责,职责分清)。
 * 故意不落临时快照:Read 的输出本就是某真文件的内容,快照只会冗余且随文件变动而过期。
 * 其余工具(Grep/Bash/...)的标题参数非文件路径,原样返回纯文本。
 */
function toolHeaderArgsNode(tool: UIToolCall, cwd: string, args: string): string {
  if (!FILE_PATH_TOOLS.has(tool.name)) return args
  const fp = (tool.input as { file_path?: unknown }).file_path
  if (typeof fp !== 'string' || fp === '') return args
  // 基准优先用工具运行时 cwd(Bash cd 后入口 cwd 已过期),与文件清单同一处理。
  return osc8FileLink(resolve(tool.cwd ?? cwd, fp), args)
}

/**
 * 工具块(仿 cc-haha 紧凑式):
 *   ● Read(/path/to/file)
 *     ⎿ Read 43 lines
 * 标题行 ● + 加粗工具名 + 灰色 (参数);结果摘要挂在下方 ⎿ 行,不再用 IN/OUT 边框盒子。
 */
function ToolBlock({ tool, cwd }: { tool: UIToolCall; cwd: string }) {
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
          {args ? <Text dimColor>({toolHeaderArgsNode(tool, cwd, args)})</Text> : null}
        </Text>
      </Box>
      {/* 结果行:⎿ 摘要;多行(预览 / diff)在 ⎿ 右侧悬挂对齐。 */}
      <Box flexDirection="row">
        <Box marginLeft={2} marginRight={1} flexShrink={0}>
          <Text dimColor>{L_CORNER}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <OutputCell tool={tool} cwd={cwd} />
        </Box>
      </Box>
    </Box>
  )
}

/**
 * 文件清单(Glob / Grep files 模式)解析相对路径的基准目录。
 * Glob 的相对路径相对 base = cwd(+ input.cwd);Grep 的相对路径相对 cwd,绝对路径(给了 path 时)
 * 经 resolve 原样保留。统一交给 resolve(base, line) 处理。
 */
function fileListBase(tool: UIToolCall, cwd: string): string {
  // 优先用工具运行时记录的 cwd(Bash cd 后 App 入口 cwd 已过期);未记录时回落到入口 cwd。
  const baseCwd = tool.cwd ?? cwd
  if (tool.name === 'Glob') {
    const sub = (tool.input as { cwd?: unknown }).cwd
    return typeof sub === 'string' ? resolve(baseCwd, sub) : baseCwd
  }
  return baseCwd
}

/** 文件清单:首行计数,其余每行一个命中文件,包成 OSC 8 链接(支持的终端可 ctrl+点击)。 */
function FileList({
  tool,
  cwd,
  paths,
  moreCount,
}: {
  tool: UIToolCall
  cwd: string
  paths: string[]
  moreCount: number
}): ReactElement {
  const total = paths.length + moreCount
  const base = fileListBase(tool, cwd)
  return (
    <Box flexDirection="column">
      <Text dimColor>{`Found ${plural(total, 'file')}`}</Text>
      {paths.map((p) => (
        // 链接目标必须是绝对路径;展示文字保留工具原样输出(相对或绝对)。
        // key 用路径本身:同一次工具结果内命中路径唯一,比数组下标更稳。
        <Text key={p} dimColor>
          {osc8FileLink(resolve(base, p), p)}
        </Text>
      ))}
      {moreCount > 0 && (
        // 余下文件:有落盘文件时把整行包成链接,ctrl+点击打开临时文件看全体命中;
        // 落盘失败(无 outputFile)则退化为纯文本提示。
        <Text dimColor>
          {tool.outputFile
            ? osc8FileLink(tool.outputFile, `… +${moreCount} 个(点击查看全部)`)
            : `… +${moreCount} 个`}
        </Text>
      )}
    </Box>
  )
}

/** OUT 列内容:运行中显示「运行中…」;完成后按 summarizeOutput 渲染(Edit 走彩色行级 diff)。 */
function OutputCell({ tool, cwd }: { tool: UIToolCall; cwd: string }): ReactElement {
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
  if (summary.kind === 'files') {
    return <FileList tool={tool} cwd={cwd} paths={summary.paths} moreCount={summary.moreCount} />
  }
  if (summary.kind === 'line') {
    // line 类不会来自错误(错误走 error/preview),恒为暗色。
    // 有落盘文件(如 Grep content/count 隐藏了命中内容)时,整行计数包成可点击链接。
    return tool.outputFile ? (
      <Text dimColor>{osc8FileLink(tool.outputFile, summary.text)}</Text>
    ) : (
      <Text dimColor>{summary.text}</Text>
    )
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
  const { rows: shown, more } = capDiff(rows, EDIT_DIFF_CAP)
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
      {more > 0 &&
        (tool.outputFile ? (
          // 完整 diff 已落盘:整行包成 OSC 8 链接,ctrl+点击打开临时文件看全量 diff。
          <Text dimColor>{osc8FileLink(tool.outputFile, `… +${more} 行(点击查看完整 diff)`)}</Text>
        ) : (
          <Text dimColor>{`… +${more} 行`}</Text>
        ))}
    </Box>
  )
}

export function StreamRenderer({ message, cwd }: StreamRendererProps) {
  // 工具调用：一行青色的 "Name(args)"，带状态标记 + 结果预览。
  if (message.role === 'tool' && message.tool) {
    return <ToolBlock tool={message.tool} cwd={cwd} />
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
    // displayText 存在时按折叠回显渲染（含 [粘贴#x] 标签），否则回落到全文
    const lines = (message.displayText ?? message.text).split('\n')
    const pasteFiles = message.pasteFiles
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          // 保持原有底色高亮（blackBright 底 whiteBright 字）；标签段有临时文件时包成 OSC-8 链接
          <Text key={i} backgroundColor="blackBright" color="whiteBright">
            {`${i === 0 ? '› ' : '  '}`}
            {splitPasteLabels(line).map((seg, j) => {
              const filePath = seg.id !== undefined ? pasteFiles?.[seg.id] : undefined
              // 有落盘文件：包成 OSC-8 超链接；否则纯文本（含标签退化场景，不崩）
              return filePath ? osc8FileLink(filePath, seg.text) : seg.text
            }).join('')}
            {' '}
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
