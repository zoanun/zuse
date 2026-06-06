import OpenAI from 'openai'
import type { Message, ContentBlock, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import { emptyUsage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'

/** zuse Message[] → OpenAI chat messages。system 置顶；tool_result 提升为顶层 tool 消息。 */
export function toOpenAIMessages(
  messages: Message[],
  system: string | undefined,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    // tool_result 块各自成为一条顶层 { role:'tool' } 消息（OpenAI 的结构差异）。
    const toolResults = m.content.filter((b) => b.type === 'tool_result')
    for (const b of toolResults) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
      }
    }

    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    // 类型谓词 filter 让 TS 把 toolUses 收窄为 tool_use 块数组，下面 map 即可直接取 id/name/input。
    const toolUses = m.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    )

    if (m.role === 'assistant' && toolUses.length > 0) {
      // assistant 同时含 text + tool_use 时合成一条带 tool_calls 的消息。
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        })),
      })
    } else if (text) {
      // 纯文本消息（user 或 assistant）。只含 tool_result 的 user 消息已在上面处理，跳过空壳。
      out.push({ role: m.role, content: text })
    }
  }
  return out
}

/** zuse ToolDefinition[] → OpenAI tools（input_schema → function.parameters）。 */
export function toOpenAITools(defs: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.input_schema as Record<string, unknown> },
  }))
}

/** finish_reason → zuse stop_reason。 */
function mapStopReason(reason: string | null | undefined): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  // 截断映射成 'max_tokens'（与 Anthropic 同名），不再伪装成正常结束 ——
  // 这样 Agent 循环能识别并告警，而不是把被砍断的回复当成完整回复。
  if (reason === 'length') return 'max_tokens'
  return reason || 'end_turn'
}

/** 流式 tool_call 片段的累积状态。 */
interface AccTool {
  id: string
  name: string
  args: string
}

/**
 * OpenAI 流 → zuse StreamEvent。
 * message-start / text-delta 即时产出；tool-use 与 message-stop 在流结束后产出
 *（与 AnthropicClient 一致：先收集 tool_use，再 stop）。
 * 入参用 unknown 以便单测用 mock chunk 注入，实际生产路径喂真实 OpenAI 流。
 */
export async function* streamToEvents(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
  let started = false
  let stopReason = 'end_turn'
  const tools = new Map<number, AccTool>()
  let usage: Usage = emptyUsage()

  for await (const raw of stream) {
    // 将 unknown chunk 断言为 OpenAI SDK 的完整 chunk 形状，在单测中由 mock 数据满足。
    // SDK 的 chunk 类型里 usage 仅在 stream_options.include_usage 时出现，
    // 且 prompt_tokens_details.cached_tokens 在部分版本未标注类型，这里有意手动扩展形状作为 workaround。
    const chunk = raw as OpenAI.Chat.ChatCompletionChunk & {
      usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
    }

    if (!started) {
      started = true
      yield { type: 'message-start', id: chunk.id, model: chunk.model }
    }

    const choice = chunk.choices[0]
    if (choice) {
      const delta = choice.delta
      // 文本增量即时产出。
      if (delta?.content) yield { type: 'text-delta', text: delta.content }
      // tool_calls 片段按 index 累积：id/name 只在首片出现，arguments 可能分多片。
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const acc = tools.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.args += tc.function.arguments
          tools.set(tc.index, acc)
        }
      }
      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason)
    }

    // usage 在末尾 chunk（stream_options.include_usage）里携带。
    if (chunk.usage) {
      // OpenAI 规范里 prompt_tokens 含缓存命中部分（cached ⊆ prompt）；减去 cached_tokens
      // 归一到「新输入」口径，与 Anthropic 的 input_tokens 对齐（见 Usage 注释）。
      // 但部分聚合转发端（如 gptsapi）违规把 cached 报得比 prompt_tokens 还大，说明它的
      // prompt_tokens 本就不含缓存；这种情况下别再减，否则 input_tokens 变负、污染累计
      // （症状：footer 里 cache 累计看着比 Total 还多）。故只在 cached ≤ prompt 时才减。
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      const promptTokens = chunk.usage.prompt_tokens
      usage = {
        input_tokens: cached > promptTokens ? promptTokens : promptTokens - cached,
        output_tokens: chunk.usage.completion_tokens,
        cache_read_input_tokens: cached,
      }
    }
  }

  // 按 index 升序产出 tool-use；空参数串按 {} 处理。
  for (const idx of [...tools.keys()].sort((a, b) => a - b)) {
    const t = tools.get(idx)!
    let input: unknown = {}
    if (t.args) {
      try {
        input = JSON.parse(t.args)
      } catch {
        // 非空但非法/截断的参数串：不能静默当成 {} 让工具空参运行，
        // 产出 error 让 Agent 循环中止本回合（不提交），用户可见而非默默跑错。
        yield {
          type: 'error',
          message: `模型生成的工具调用参数不是合法 JSON（tool=${t.name}）：${t.args.slice(0, 200)}`,
        }
        return
      }
    }
    yield { type: 'tool-use', id: t.id, name: t.name, input }
  }
  yield { type: 'message-stop', stop_reason: stopReason, usage }
}

/**
 * OpenAIClient —— 用 openai SDK 实现 ModelClient。
 * 覆盖 OpenAI 原生及一切 OpenAI 兼容端点（DeepSeek / Ollama / vLLM …）。
 */
export class OpenAIClient implements ModelClient {
  private client: OpenAI
  private model: string

  /** sdk 可注入，便于单测；省略时按 provider 配置 new 一个。 */
  constructor(provider: ProviderConfig, model: string, sdk?: OpenAI) {
    this.client = sdk ?? new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL })
    this.model = model
  }

  getModel(): string {
    return this.model
  }

  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent> {
    const model = config.model || this.model
    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: config.max_tokens,
        messages: toOpenAIMessages(messages, config.system),
        ...(tools && tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      })
      yield* streamToEvents(stream)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      yield { type: 'error', message }
    }
  }
}
