import type { Message, ContentBlock, StreamEvent, ModelConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolContext, ToolRegistry, FileReadTracker } from './tool.js'
import { createFileTracker } from './tool.js'
import type { Conversation } from './conversation.js'

/** 每个用户回合内模型<->工具往返次数的默认上限（故障模式①）。 */
export const DEFAULT_MAX_TURNS = 50

export interface RunAgentOptions {
  conversation: Conversation
  client: ModelClient
  registry: ToolRegistry
  /** 本回合用户的新输入。 */
  userText: string
  config: ModelConfig
  cwd: string
  signal: AbortSignal
  maxTurns?: number
  /**
   * read-before-edit 用的文件追踪器。由调用方（TUI）按会话持有并传入，
   * 这样跨多次 runAgent 调用（多个用户回合）的读取记录得以保留。
   * 缺省时每次新建一个 —— 测试与无头调用无需关心。
   */
  tracker?: FileReadTracker
}

interface PendingToolUse {
  id: string
  name: string
  input: unknown
}

/**
 * runAgent —— Agent 循环（spec §4.2）。驱动模型和工具，产出一个与厂商
 * 无关的事件流供 UI 订阅。
 *
 * 循环：问模型 -> 如果它想用工具，就运行工具并把结果回喂 -> 再问 -> ...
 * 直到模型结束本回合（或我们触达 maxTurns）。
 *
 * 新消息（用户输入、助手的工具调用、工具结果）先在本地暂存（staged），
 * 只在干净完成时才原子性地提交进 `conversation`。如果回合中途出错或被中断，
 * 什么都不提交 —— 这样账本永远不会以一个悬空的 user/tool_result 收尾而
 * 破坏角色交替。
 */
export async function* runAgent(opts: RunAgentOptions): AsyncIterable<StreamEvent> {
  const { conversation, client, registry, userText, config, cwd, signal } = opts
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const tracker = opts.tracker ?? createFileTracker()

  const base = conversation.getMessages()
  const staged: Message[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const turnUsage: Usage = { input_tokens: 0, output_tokens: 0 }

  const toolDefs = registry.getDefinitions()

  let clean = false

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) {
      yield { type: 'warning', message: 'Interrupted.' }
      return // 丢弃 staged —— 什么都不提交
    }

    let text = ''
    const toolUses: PendingToolUse[] = []
    let stopReason = ''
    let errored = false

    for await (const event of client.sendMessages([...base, ...staged], config, toolDefs)) {
      if (event.type === 'text-delta') {
        text += event.text
        yield event
      } else if (event.type === 'tool-use') {
        toolUses.push({ id: event.id, name: event.name, input: event.input })
        yield event
      } else if (event.type === 'message-start') {
        yield event
      } else if (event.type === 'message-stop') {
        stopReason = event.stop_reason
        turnUsage.input_tokens += event.usage.input_tokens
        turnUsage.output_tokens += event.usage.output_tokens
        yield event
      } else if (event.type === 'error') {
        yield event
        errored = true
        break
      }
    }

    if (errored) return // 模型调用失败时什么都不提交

    // 重建助手消息（text + 任何 tool_use 块）并暂存它。
    const assistantContent: ContentBlock[] = []
    if (text) assistantContent.push({ type: 'text', text })
    for (const tu of toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    }
    staged.push({ role: 'assistant', content: assistantContent })

    // 没有请求工具 -> 模型完事了。提交并结束。
    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      clean = true
      break
    }

    // 执行每个被请求的工具，并把结果作为一条 user 消息暂存。
    const ctx: ToolContext = { cwd, signal, tracker }
    const resultBlocks: ContentBlock[] = []
    for (const tu of toolUses) {
      const result = await runOneTool(registry, tu, ctx)
      yield {
        type: 'tool-result',
        id: tu.id,
        name: tu.name,
        output: result.output,
        is_error: result.isError,
      }
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: result.isError,
      })
    }
    staged.push({ role: 'user', content: resultBlocks })
    // 循环：把工具结果回喂给模型
  }

  if (!clean) {
    // 在循环中途触达 maxTurns：最后一条暂存消息是 user 的 tool_result，
    // 所以补一条助手收尾消息以保持角色交替合法，然后告警。
    staged.push({
      role: 'assistant',
      content: [{ type: 'text', text: `[Stopped: reached max turns (${maxTurns}).]` }],
    })
    yield { type: 'warning', message: `Reached max turns (${maxTurns}); stopping.` }
  }

  // 原子性地提交整个回合。
  for (const m of staged) conversation.append(m)
  conversation.addUsage(turnUsage)
}

/** 运行单个工具，把"未知工具"和抛出的错误转换成 is_error 结果（故障模式④）。 */
async function runOneTool(
  registry: ToolRegistry,
  tu: PendingToolUse,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const tool = registry.get(tu.name)
  if (!tool) {
    return { output: `Unknown tool: ${tu.name}`, isError: true }
  }
  try {
    const result = await tool.run(tu.input, ctx)
    return { output: result.output, isError: result.isError ?? false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { output: `Tool "${tu.name}" failed: ${message}`, isError: true }
  }
}
