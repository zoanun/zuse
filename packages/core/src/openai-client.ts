// 仅作类型用途导入 SDK（verbatimModuleSyntax 下 import type 会被完全擦除，
// 不会在模块求值时拉起 openai）。运行时实例改由 getClient() 懒加载。
import type OpenAI from 'openai'
import type { Message, ContentBlock, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import { emptyUsage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'
import { debugLog, debugEnabled } from './debug-log.js'
import { StreamIdleGuard, resolveStreamIdleMs } from './stream-idle.js'
import { resolveMaxRetries, isRetryableError, classifyError, retryAfterMs, backoffMs, sleep } from './retry.js'

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

/**
 * 把发往模型的消息压成一行诊断摘要：只留 role、字符数、以及 tool 调用/结果的配对关系，
 * 不打 system prompt 全文与工具输出全文（那些每轮重复、淹没日志）。
 */
function summarizeMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): unknown[] {
  return messages.map((m) => {
    const chars = typeof m.content === 'string' ? m.content.length : 0
    if (m.role === 'assistant') {
      // tool_calls 是 function/custom 联合类型，只有 function 变体带 .function（我们只生成 function 类型）。
      const calls = m.tool_calls?.map((t) => (t.type === 'function' ? `${t.function.name}#${t.id}` : t.id)) ?? []
      return { role: 'assistant', chars, tool_calls: calls }
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, chars }
    return { role: m.role, chars }
  })
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
  // 仅用于诊断：累计可见文本与思维链字段长度，回合结束时汇总落盘，
  // 用来分辨「模型真返回空」与「内容跑进了 reasoning_content 被丢弃」。
  let textLen = 0
  let reasoningLen = 0

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
      // OpenRouter / kimi 等推理模型可能把内容放进 reasoning / reasoning_content，
      // 这两个字段不在 SDK 的 delta 类型里，手动扩展形状以便诊断时读取。
      const delta = choice.delta as (typeof choice.delta & { reasoning?: string; reasoning_content?: string }) | undefined
      const reasoning = delta?.reasoning ?? delta?.reasoning_content
      // 诊断：只记真正带内容的 chunk（content/reasoning/tool_calls），跳过空 chunk 刷屏；
      // 聚合长度由本回合末尾的 turn-summary 承担。
      if (debugEnabled() && (delta?.content || reasoning || delta?.tool_calls)) {
        debugLog('openai.delta', {
          content: delta?.content || undefined,
          reasoning: reasoning || undefined,
          tool_calls: delta?.tool_calls,
        })
      }
      if (reasoning) reasoningLen += reasoning.length
      // 文本增量即时产出。
      if (delta?.content) {
        textLen += delta.content.length
        yield { type: 'text-delta', text: delta.content }
      }
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
        // 非空但非法/截断的参数串：既不能静默当成 {} 让工具空参运行，也不再 error 中止
        // 整回合（那会连已流出的文本一起作废、模型零自纠机会）。改为带 invalid_args 的
        // tool-use 透出，Agent 循环合成 is_error tool_result 回喂、模型下一轮重发
        // （Phase 11，spec §2）。id 缺失（弱端点）时合成兜底 id 保证 tool_result 可配对。
        yield {
          type: 'tool-use',
          id: t.id || `invalid-json-${idx}`,
          name: t.name,
          input: {},
          invalid_args: t.args.slice(0, 200),
        }
        continue
      }
    }
    yield { type: 'tool-use', id: t.id, name: t.name, input }
  }
  // 诊断汇总：本回合到底产出了什么。textLen=0 且 toolCount=0 即「空回合」——
  // 若此时 reasoningLen>0，说明内容跑进了未渲染的 reasoning 字段（候选 B）；
  // 若 reasoningLen 也为 0、stopReason=end_turn，则是端点真返回了空（候选 A）。
  if (debugEnabled()) {
    debugLog('openai.turn-summary', { stopReason, textLen, reasoningLen, toolCount: tools.size, usage })
  }
  yield { type: 'message-stop', stop_reason: stopReason, usage }
}

/**
 * OpenAIClient —— 用 openai SDK 实现 ModelClient。
 * 覆盖 OpenAI 原生及一切 OpenAI 兼容端点（DeepSeek / Ollama / vLLM …）。
 */
export class OpenAIClient implements ModelClient {
  private clientPromise?: Promise<OpenAI>
  private model: string
  private provider: ProviderConfig
  /** 单测注入的 sdk；存在时直接用，跳过懒加载。 */
  private injectedClient?: OpenAI

  /** sdk 可注入，便于单测；省略时首次发请求时按 provider 配置懒加载并 new 一个。 */
  constructor(provider: ProviderConfig, model: string, sdk?: OpenAI) {
    this.provider = provider
    this.model = model
    this.injectedClient = sdk
  }

  getModel(): string {
    return this.model
  }

  /**
   * 懒加载 SDK：把 `openai` 的导入推迟到首次真正发请求时。
   * 这样启动期（仅 new client + 读 getModel）完全不触碰 SDK 模块，首帧更快。
   * 注入了 sdk（单测）则直接复用；否则 import() 结果记忆化，只构建一次实例。
   */
  private getClient(): Promise<OpenAI> {
    if (this.injectedClient) return Promise.resolve(this.injectedClient)
    if (!this.clientPromise) {
      this.clientPromise = import('openai').then(
        ({ default: OpenAISDK }) =>
          new OpenAISDK({ apiKey: this.provider.apiKey, baseURL: this.provider.baseURL }),
      )
    }
    return this.clientPromise
  }

  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const model = config.model || this.model
    const oaiMessages = toOpenAIMessages(messages, config.system)
    const maxRetries = resolveMaxRetries()

    // 瞬时错误自动重试：仅当失败发生在「向下游产出任何事件之前」（开流/首块前的 429/5xx/网络抖动）才退避重来。
    // 每次尝试新建一个 StreamIdleGuard（独立的空闲计时 + signal 接线），并在各自的 finally 中 dispose。
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 空闲守卫：把用户 Esc 与「流卡死」合并到一个信号传给 SDK，并用 tap 监视数据间隔。
      const guard = new StreamIdleGuard(resolveStreamIdleMs(), signal)
      let emitted = false // 是否已向下游发出过任何事件（发过就绝不重试，避免重复 message-start/文本）。
      try {
        // 诊断：记下本次发出去的请求（每个用户回合内可能调用多次，第二次即工具结果回喂）。
        if (debugEnabled()) {
          debugLog('openai.request', { model, toolCount: tools?.length ?? 0, messages: summarizeMessages(oaiMessages) })
        }
        const client = await this.getClient()
        const stream = await client.chat.completions.create(
          {
            model,
            max_tokens: config.max_tokens,
            messages: oaiMessages,
            ...(tools && tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: guard.signal },
        )
        // 诊断：流已开启。若日志里有 request 却没有这条，说明卡在 create()（端点挂死/超时）；
        // 有这条却没有后续 delta，说明流开启后中途卡死。
        if (debugEnabled()) debugLog('openai.stream-open', { model })
        for await (const ev of streamToEvents(guard.tap(stream))) {
          emitted = true
          yield ev
        }
        return // 正常结束
      } catch (err) {
        // 用户 Esc / 空闲超时：绝不重试，按原有逻辑产出 error 文案。
        if (signal?.aborted || guard.timedOut) {
          // 空闲超时：给出明确的「卡死已中断、可重试」文案；外部 Esc 中断由 TUI 侧渲染成「已中断」。
          const message = guard.timedOut
            ? `模型流空闲超过 ${Math.round(resolveStreamIdleMs() / 1000)}s 无响应，已中断（可重试）。`
            : err instanceof Error
              ? err.message
              : 'Unknown error'
          // 诊断：把异常也记下来，区分「端点报错」「请求挂死（空闲超时）」与「用户中断」。
          if (debugEnabled()) {
            debugLog('openai.error', {
              message,
              timedOut: guard.timedOut,
              aborted: signal?.aborted ?? false,
              name: err instanceof Error ? err.name : undefined,
            })
          }
          yield { type: 'error', message, ...classifyError(err) }
          return
        }

        const message = err instanceof Error ? err.message : 'Unknown error'

        // 已经向下游发过事件：流到中途才断，重试会重复 message-start/文本 → 不重试。
        if (emitted) {
          if (debugEnabled()) {
            debugLog('openai.error', { message, timedOut: false, aborted: false, name: err instanceof Error ? err.name : undefined })
          }
          yield { type: 'error', message, ...classifyError(err) }
          return
        }

        // 还没发过事件、错误可重试、还有重试次数：退避后重来。
        if (attempt < maxRetries && isRetryableError(err)) {
          debugLog('openai.retry', { attempt: attempt + 1, max: maxRetries, message })
          await sleep(backoffMs(attempt, { retryAfter: retryAfterMs(err) }), signal)
          continue
        }

        // 不可重试或重试用尽。
        if (debugEnabled()) {
          debugLog('openai.error', { message, timedOut: false, aborted: false, name: err instanceof Error ? err.name : undefined })
        }
        yield { type: 'error', message, ...classifyError(err) }
        return
      } finally {
        guard.dispose()
      }
    }
  }
}
