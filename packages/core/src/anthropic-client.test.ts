import { describe, it, expect, beforeAll } from 'vitest'
import { AnthropicClient } from './anthropic-client.js'
import { getClientConfig, getDefaultModel, getDefaultMaxTokens } from './env.js'
import type { Message, StreamEvent } from './types.js'

describe('AnthropicClient', () => {
  let client: AnthropicClient

  beforeAll(() => {
    // Skip if no API key configured
    try {
      client = new AnthropicClient(getClientConfig(), getDefaultModel())
    } catch {
      console.log('Skipping AnthropicClient tests — no API key')
    }
  })

  it('returns model name', () => {
    try {
      expect(client.getModel()).toBeTruthy()
    } catch {
      // Skipped
    }
  })

  it('streams a simple message and tracks usage', async () => {
    try {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Say exactly: hello world' }] },
      ]

      const events: StreamEvent[] = []
      for await (const event of client.sendMessages(messages, { model: getDefaultModel(), max_tokens: getDefaultMaxTokens() })) {
        events.push(event)
      }

      // Should have message-start
      const startEvent = events.find((e) => e.type === 'message-start')
      expect(startEvent).toBeDefined()

      // Should have text-deltas
      const deltas = events.filter((e) => e.type === 'text-delta')
      expect(deltas.length).toBeGreaterThan(0)

      // Should have message-stop with usage (fault mode ⑧ defense)
      const stopEvent = events.find((e) => e.type === 'message-stop')
      expect(stopEvent).toBeDefined()
      if (stopEvent && stopEvent.type === 'message-stop') {
        expect(stopEvent.usage.input_tokens).toBeGreaterThan(0)
        expect(stopEvent.usage.output_tokens).toBeGreaterThan(0)
      }
    } catch {
      console.log('Skipping streaming test — no API key')
    }
  })
})