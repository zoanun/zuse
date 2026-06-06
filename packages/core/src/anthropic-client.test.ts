import { describe, it, expect, beforeAll } from 'vitest'
import { AnthropicClient, buildAnthropicRequest } from './anthropic-client.js'
import { loadSettings, resolveModelSelection, getProviderConfig, getDefaultMaxTokens } from './settings.js'
import type { Message, StreamEvent } from './types.js'
import type { ToolDefinition } from './tool.js'

describe('buildAnthropicRequest cache_control', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const tools: ToolDefinition[] = [
    { name: 'Read', description: 'r', input_schema: { type: 'object', properties: {} } },
    { name: 'Bash', description: 'b', input_schema: { type: 'object', properties: {} } },
  ]

  it('marks system as a cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10, system: 'SYS' }, tools)
    expect(Array.isArray(req.system)).toBe(true)
    const sys = req.system as unknown as Array<Record<string, unknown>>
    expect(sys[0]).toMatchObject({ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } })
  })

  it('marks the last tool definition as a cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    const t = req.tools as unknown as Array<Record<string, unknown>>
    expect(t[0]!.cache_control).toBeUndefined()
    expect(t[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks the last message as a rolling cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    const msgs = req.messages as unknown as Array<{ content: Array<Record<string, unknown>> }>
    const lastBlocks = msgs[msgs.length - 1]!.content
    expect(lastBlocks[lastBlocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('omits system field entirely when no system prompt', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    expect('system' in req).toBe(false)
  })
})

describe('AnthropicClient (live, skipped without key)', () => {
  let client: AnthropicClient | undefined
  const settings = loadSettings()
  const sel = resolveModelSelection(settings)

  beforeAll(() => {
    try {
      const provider = getProviderConfig(settings, sel.providerId)
      // 仅当默认 provider 走 anthropic 协议时才跑 live 测试；默认是 openai 协议
      // 的 provider（如 deepseek）时跳过——否则把 Anthropic 请求发到 OpenAI 端点必然失败。
      if (provider.protocol !== 'anthropic') {
        console.log(`Skipping live AnthropicClient tests — default provider "${sel.providerId}" is not anthropic protocol`)
        return
      }
      client = new AnthropicClient(provider, sel.model)
    } catch {
      console.log('Skipping live AnthropicClient tests — no API key')
    }
  })

  it('returns model name', () => {
    if (!client) return
    expect(client.getModel()).toBeTruthy()
  })

  it('streams and tracks usage', async () => {
    if (!client) return
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Say exactly: hello world' }] }]
    const events: StreamEvent[] = []
    for await (const e of client.sendMessages(messages, { model: sel.model, max_tokens: getDefaultMaxTokens(settings) })) {
      events.push(e)
    }
    expect(events.find((e) => e.type === 'message-start')).toBeTruthy()
    expect(events.find((e) => e.type === 'message-stop')).toBeTruthy()
  }, 15_000)
})
