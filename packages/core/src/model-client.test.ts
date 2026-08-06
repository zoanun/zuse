import { describe, it, expect } from 'vitest'
import { createModelClient, buildProviderIndex } from './model-client.js'
import { BUILTIN_PROVIDER_MODULES } from './builtin-providers.js'
import { AnthropicClient, anthropicProviderModule } from './anthropic-client.js'
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

  // 协议放宽成 string 后，IDE 不再对 protocol 字面量补全。作为补偿，未知协议的报错
  // 必须把已知协议列出来 —— 否则「用错误信息补偿补全」就是句空话。
  it('throws on unknown protocol, listing the known ones', () => {
    const bad = { ...anthropic, protocol: 'grpc' }
    expect(() => createModelClient(bad, 'm')).toThrow('Unknown provider protocol "grpc"')
    expect(() => createModelClient(bad, 'm')).toThrow('Known protocols: anthropic, openai')
  })
})

describe('BUILTIN_PROVIDER_MODULES', () => {
  // 全集回归锁（对齐 tools 的 builtin-tools.test.ts）：防误删、防误序 ——
  // 顺序决定上面那条错误信息里协议的列出顺序。
  it('内置协议集与顺序固定', () => {
    expect(BUILTIN_PROVIDER_MODULES.map((m) => m.protocol)).toEqual(['anthropic', 'openai'])
  })

  // 模块本身也要被直接测到，不能只靠 createModelClient 的默认路径间接覆盖。
  it('模块的 make 与直接 new 等价', () => {
    const viaModule = anthropicProviderModule.make(anthropic, 'm')
    expect(viaModule).toBeInstanceOf(AnthropicClient)
    expect(viaModule.getModel()).toBe(new AnthropicClient(anthropic, 'm').getModel())
  })
})

describe('buildProviderIndex', () => {
  it('按 protocol 建索引', () => {
    const index = buildProviderIndex(BUILTIN_PROVIDER_MODULES)
    expect([...index.keys()]).toEqual(['anthropic', 'openai'])
    expect(index.get('openai')).toBe(BUILTIN_PROVIDER_MODULES[1])
  })

  // 重复协议名是编程错误。静默让后者覆盖前者会让「加了个协议但没生效」变成哑谜。
  it('协议名重复时抛错，不静默覆盖', () => {
    const dup = [anthropicProviderModule, { protocol: 'anthropic', make: () => ({}) as never }]
    expect(() => buildProviderIndex(dup)).toThrow('Duplicate provider protocol: anthropic')
  })
})
