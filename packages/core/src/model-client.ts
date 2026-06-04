import type { Message, StreamEvent, ModelConfig, ClientConfig } from './types.js'
import type { ToolDefinition } from './tool.js'

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
   */
  sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent>

  /** 获取模型名称（用于展示） */
  getModel(): string
}

/**
 * 创建 client 的工厂函数签名。
 * 由 TUI 用来根据配置拿到合适的 client。
 */
export type ModelClientFactory = (config: ClientConfig) => ModelClient
