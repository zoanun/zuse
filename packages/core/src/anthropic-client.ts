import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'

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
  private client: Anthropic
  private model: string

  constructor(provider: ProviderConfig, model: string) {
    this.client = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL })
    this.model = model
  }

  getModel(): string {
    return this.model
  }

  /**
   * 发送消息并产出流式事件。
   * 使用 Anthropic SDK 的 stream 辅助方法，得到干净的 AsyncIterable 模式。
   */
  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent> {
    // 组装请求参数，model 优先取 config.model，其次回退到构造时的 this.model。
    const params = buildAnthropicRequest(messages, { ...config, model: config.model || this.model }, tools)
    try {
      const stream = this.client.messages.stream(params)
      for await (const event of stream) {
        if (event.type === 'message_start') {
          yield { type: 'message-start', id: event.message.id, model: event.message.model }
        } else if (event.type === 'content_block_delta') {
          // text_delta 直接转发；input_json_delta（工具参数流）从 finalMessage 整体读取。
          if (event.delta.type === 'text_delta') yield { type: 'text-delta', text: event.delta.text }
        } else if (event.type === 'message_delta') {
          // message_delta 会多次到达，stop_reason 仅在最后一个非空——以此为界，拿 finalMessage 统一收尾。
          if (event.delta.stop_reason) {
            const finalMessage = await stream.finalMessage()
            // 在 message-stop 之前，先为每个 tool_use 块发事件，Agent 借此收集工具调用。
            for (const block of finalMessage.content) {
              if (block.type === 'tool_use') {
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
            yield { type: 'message-stop', stop_reason: event.delta.stop_reason, usage }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      yield { type: 'error', message }
    }
  }
}
