import type { Message, StreamEvent, ModelConfig, ClientConfig } from './types.js'

/**
 * ModelClient interface — provider-agnostic API for sending messages.
 * Returns AsyncIterable<StreamEvent> for streaming response.
 *
 * Implementations: AnthropicClient (Phase 1), OpenAIClient (Phase 6)
 */
export interface ModelClient {
  /** Send messages and receive streaming events */
  sendMessages(
    messages: Message[],
    config: ModelConfig
  ): AsyncIterable<StreamEvent>

  /** Get model name (for display) */
  getModel(): string
}

/**
 * Factory function signature for creating clients.
 * Used by TUI to get the right client based on config.
 */
export type ModelClientFactory = (config: ClientConfig) => ModelClient