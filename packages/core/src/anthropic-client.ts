import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ClientConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import { getClientConfig, getDefaultModel } from './env.js'

/**
 * AnthropicClient — implements ModelClient using @anthropic-ai/sdk.
 * Works with Anthropic native API and Anthropic-compatible endpoints (DashScope, etc.)
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
   * Send messages and yield streaming events.
   * Uses Anthropic SDK's stream helper for clean AsyncIterable pattern.
   */
  async *sendMessages(
    messages: Message[],
    config: ModelConfig
  ): AsyncIterable<StreamEvent> {
    // Convert our Message type to Anthropic SDK format
    const sdkMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        }
        return block
      }),
    }))

    const model = config.model || this.model
    const maxTokens = config.max_tokens

    try {
      const stream = this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        messages: sdkMessages,
      })

      let messageId = ''
      let responseModel = model

      yield { type: 'message-start', id: messageId, model: responseModel }

      for await (const event of stream) {
        if (event.type === 'message_start') {
          messageId = event.message.id
          responseModel = event.message.model
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text-delta', text: event.delta.text }
          }
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason) {
            const finalMessage = await stream.finalMessage()
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
 * Create AnthropicClient with environment config.
 */
export function createAnthropicClientFromEnv(): AnthropicClient {
  return new AnthropicClient(getClientConfig())
}