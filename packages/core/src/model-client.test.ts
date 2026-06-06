import { describe, it, expect } from 'vitest'
import { createModelClient } from './model-client.js'
import { AnthropicClient } from './anthropic-client.js'
import { OpenAIClient } from './openai-client.js'
import type { ProviderConfig } from './types.js'

const anthropic: ProviderConfig = { id: 'q', protocol: 'anthropic', baseURL: 'https://h', apiKey: 'k', models: [] }
const openai: ProviderConfig = { id: 'd', protocol: 'openai', baseURL: 'https://h/v1', apiKey: 'k', models: [] }

describe('createModelClient', () => {
  it('builds an AnthropicClient for protocol "anthropic"', () => {
    const c = createModelClient(anthropic, 'm')
    expect(c).toBeInstanceOf(AnthropicClient)
    expect(c.getModel()).toBe('m')
  })
  it('builds an OpenAIClient for protocol "openai"', () => {
    const c = createModelClient(openai, 'm')
    expect(c).toBeInstanceOf(OpenAIClient)
    expect(c.getModel()).toBe('m')
  })
  it('throws on unknown protocol', () => {
    const bad = { ...anthropic, protocol: 'grpc' as never }
    expect(() => createModelClient(bad, 'm')).toThrow('Unknown provider protocol: grpc')
  })
})
