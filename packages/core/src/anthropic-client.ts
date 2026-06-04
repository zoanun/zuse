import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ClientConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'
import { getClientConfig, getDefaultModel } from './env.js'

/**
 * AnthropicClient —— 用 @anthropic-ai/sdk 实现 ModelClient。
 * 适用于 Anthropic 原生 API 以及兼容 Anthropic 协议的端点（DashScope 等）。
 */
export class AnthropicClient implements ModelClient {
  private client: Anthropic
  private model: string

  constructor(config: ClientConfig, defaultModel?: string) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })
    this.model = defaultModel || getDefaultModel()
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
    // 把我们的 Message 类型转成 Anthropic SDK 格式。text / tool_use /
    // tool_result 块几乎一对一地映射到 SDK 的内容块形状。
    const sdkMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        }
        // tool_result
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        }
      }),
    }))

    const model = config.model || this.model
    const maxTokens = config.max_tokens

    try {
      const stream = this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        messages: sdkMessages,
        // 只有在确实有工具时才公布 tools —— 让简单回合保持干净。
        ...(tools && tools.length > 0 ? { tools } : {}),
      })

      for await (const event of stream) {
        if (event.type === 'message_start') {
          yield {
            type: 'message-start',
            id: event.message.id,
            model: event.message.model,
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text-delta', text: event.delta.text }
          }
          // 这里忽略 input_json_delta（tool_use 的参数）—— 我们改为从下面的
          // finalMessage() 读取已完整拼装好的 tool_use 块，而不是去重建
          // 残缺的 JSON。
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason) {
            const finalMessage = await stream.finalMessage()
            // 在 message-stop 之前，为模型产生的每个 tool_use 块发一个
            // tool-use 事件，这样 Agent 先收集它们，再看到 stop。
            for (const block of finalMessage.content) {
              if (block.type === 'tool_use') {
                yield { type: 'tool-use', id: block.id, name: block.name, input: block.input }
              }
            }
            const usage: Usage = {
              input_tokens: finalMessage.usage.input_tokens,
              output_tokens: finalMessage.usage.output_tokens,
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

/**
 * 用环境变量配置创建 AnthropicClient。
 */
export function createAnthropicClientFromEnv(): AnthropicClient {
  return new AnthropicClient(getClientConfig())
}
