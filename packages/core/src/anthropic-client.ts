// 仅作类型用途导入 SDK（verbatimModuleSyntax 下 import type 会被完全擦除，
// 不会在模块求值时拉起 @anthropic-ai/sdk）。运行时实例改由 getClient() 懒加载。
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'
import { StreamIdleGuard, resolveStreamIdleMs } from './stream-idle.js'
import { resolveMaxRetries, isRetryableError, retryAfterMs, backoffMs, sleep } from './retry.js'
import { debugLog } from './debug-log.js'

// 缓存控制标记：ephemeral 表示"本断点之前的内容写入缓存"。
const CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }

/**
 * 组装 messages.stream() 的入参（纯函数，便于测试缓存打标）。
 * 缓存断点：system、最后一个 tool 定义、最后一条消息的最后一个块（滚动）。
 */
export function buildAnthropicRequest(
  messages: Message[],
  config: ModelConfig,
  tools?: ToolDefinition[],
): Anthropic.MessageStreamParams {
  // 把内部 Message 类型映射到 SDK 的 MessageParam 形状。
  const sdkMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'tool_use')
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      // tool_result 块
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }
    }),
  }))

  // 滚动断点：给最后一条消息的最后一个内容块挂 cache_control。
  // 每轮对话追加新消息后，旧断点随着消息前移，仍然有效；新断点锚定当前轮次末尾。
  const last = sdkMessages[sdkMessages.length - 1]
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const idx = last.content.length - 1
    // 给最后一条消息的最后一个内容块挂滚动缓存断点（spread 重建，不就地改）。
    last.content[idx] = { ...last.content[idx], cache_control: CACHE } as Anthropic.ContentBlockParam
  }

  // 工具列表断点：最后一个工具定义挂 cache_control，把整个 tools 块纳入缓存。
  const sdkTools: Anthropic.Tool[] | undefined =
    tools && tools.length > 0
      ? tools.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
          // 最后一个工具定义挂断点 → 整个 tools 块进缓存。
          ...(i === tools.length - 1 ? { cache_control: CACHE } : {}),
        }))
      : undefined

  return {
    model: config.model,
    max_tokens: config.max_tokens,
    messages: sdkMessages,
    // system 断点：有系统提示时包成数组并打标，无则完全省略该字段。
    ...(config.system ? { system: [{ type: 'text', text: config.system, cache_control: CACHE }] } : {}),
    ...(sdkTools ? { tools: sdkTools } : {}),
  }
}

/**
 * AnthropicClient —— 用 @anthropic-ai/sdk 实现 ModelClient。
 * 适用于 Anthropic 原生 API 及兼容 Anthropic 协议的端点（DashScope 等）。
 */
export class AnthropicClient implements ModelClient {
  private clientPromise?: Promise<Anthropic>
  private model: string
  private provider: ProviderConfig

  constructor(provider: ProviderConfig, model: string) {
    this.provider = provider
    this.model = model
  }

  getModel(): string {
    return this.model
  }

  /**
   * 懒加载 SDK：把 `@anthropic-ai/sdk` 的导入推迟到首次真正发请求时。
   * 这样启动期（仅 new client + 读 getModel）完全不触碰 SDK 模块，首帧更快。
   * import() 结果记忆化，同一 client 只构建一次实例。
   */
  private getClient(): Promise<Anthropic> {
    if (!this.clientPromise) {
      this.clientPromise = import('@anthropic-ai/sdk').then(
        ({ default: AnthropicSDK }) =>
          new AnthropicSDK({ apiKey: this.provider.apiKey, baseURL: this.provider.baseURL }),
      )
    }
    return this.clientPromise
  }

  /**
   * 发送消息并产出流式事件。
   * 使用 Anthropic SDK 的 stream 辅助方法，得到干净的 AsyncIterable 模式。
   */
  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // 组装请求参数，model 优先取 config.model，其次回退到构造时的 this.model。
    const params = buildAnthropicRequest(messages, { ...config, model: config.model || this.model }, tools)
    const maxRetries = resolveMaxRetries()

    // 瞬时错误自动重试：仅当失败发生在「向下游产出任何事件之前」（开流/首块前的 429/5xx/网络抖动）才退避重来。
    // 每次尝试新建一个 StreamIdleGuard（独立的空闲计时 + signal 接线），并在各自的 finally 中 dispose。
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 空闲守卫：把用户 Esc 与「流卡死」合并到一个信号传给 SDK，并用 tap 监视数据间隔。
      const guard = new StreamIdleGuard(resolveStreamIdleMs(), signal)
      let emitted = false // 是否已向下游发出过任何事件（发过就绝不重试，避免重复 message-start/文本）。
      try {
        const client = await this.getClient()
        const stream = client.messages.stream(params, { signal: guard.signal })
        for await (const event of guard.tap(stream)) {
          if (event.type === 'message_start') {
            emitted = true
            yield { type: 'message-start', id: event.message.id, model: event.message.model }
          } else if (event.type === 'content_block_delta') {
            // text_delta 直接转发；input_json_delta（工具参数流）从 finalMessage 整体读取。
            if (event.delta.type === 'text_delta') {
              emitted = true
              yield { type: 'text-delta', text: event.delta.text }
            }
          } else if (event.type === 'message_delta') {
            // message_delta 会多次到达，stop_reason 仅在最后一个非空——以此为界，拿 finalMessage 统一收尾。
            if (event.delta.stop_reason) {
              const finalMessage = await stream.finalMessage()
              // 在 message-stop 之前，先为每个 tool_use 块发事件，Agent 借此收集工具调用。
              for (const block of finalMessage.content) {
                if (block.type === 'tool_use') {
                  emitted = true
                  yield { type: 'tool-use', id: block.id, name: block.name, input: block.input }
                }
              }
              // 带上 cache 读写字段，供 TUI 统计展示。
              const u = finalMessage.usage
              const usage: Usage = {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
                cache_creation_input_tokens: u.cache_creation_input_tokens ?? undefined,
              }
              emitted = true
              yield { type: 'message-stop', stop_reason: event.delta.stop_reason, usage }
            }
          }
        }
        return // 正常结束
      } catch (err) {
        // 用户 Esc / 空闲超时：绝不重试，按原有逻辑产出 error 文案。
        if (signal?.aborted || guard.timedOut) {
          // 空闲超时：给出明确文案；外部 Esc 中断由 TUI 侧渲染成「已中断」。
          const message = guard.timedOut
            ? `模型流空闲超过 ${Math.round(resolveStreamIdleMs() / 1000)}s 无响应，已中断（可重试）。`
            : err instanceof Error
              ? err.message
              : 'Unknown error'
          yield { type: 'error', message }
          return
        }

        const message = err instanceof Error ? err.message : 'Unknown error'

        // 已经向下游发过事件：流到中途才断，重试会重复 message-start/文本 → 不重试。
        if (emitted) {
          yield { type: 'error', message }
          return
        }

        // 还没发过事件、错误可重试、还有重试次数：退避后重来。
        if (attempt < maxRetries && isRetryableError(err)) {
          debugLog('anthropic.retry', { attempt: attempt + 1, max: maxRetries, message })
          await sleep(backoffMs(attempt, { retryAfter: retryAfterMs(err) }), signal)
          continue
        }

        // 不可重试或重试用尽。
        yield { type: 'error', message }
        return
      } finally {
        guard.dispose()
      }
    }
  }
}
