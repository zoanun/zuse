import type { Message, StreamEvent, ModelConfig, ProviderConfig } from './types.js'
import type { ToolDefinition } from './tool.js'
import { AnthropicClient } from './anthropic-client.js'
import { OpenAIClient } from './openai-client.js'

/**
 * ModelClient 接口 —— 与具体厂商无关的发送消息 API。
 * 返回 AsyncIterable<StreamEvent> 用于流式响应。
 *
 * 实现：AnthropicClient（Phase 1）、OpenAIClient（Phase 6）
 */
export interface ModelClient {
  /**
   * 发送消息并接收流式事件。`tools`（Phase 3）向模型公布可调用的工具；
   * 当它存在时，模型可能产生 `tool-use` 事件。
   *
   * `signal`（可选）：外部中断信号（用户 Esc）。实现须把它接到底层 SDK 请求，
   * 这样流卡死时按 Esc 能真正取消；缺省时退化为不可中断（旧行为）。
   */
  sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>

  /** 获取模型名称（用于展示） */
  getModel(): string
}

/** 按 provider 协议选具体实现。clients 仅 type-only 依赖本文件，无运行时环。 */
export function createModelClient(provider: ProviderConfig, model: string): ModelClient {
  switch (provider.protocol) {
    case 'anthropic':
      return new AnthropicClient(provider, model)
    case 'openai':
      return new OpenAIClient(provider, model)
    default: {
      const _exhaustive: never = provider.protocol
      throw new Error(`Unknown provider protocol: ${String(_exhaustive)}`)
    }
  }
}
