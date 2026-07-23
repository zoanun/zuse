import { describe, it, expect, beforeAll } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicClient, buildAnthropicRequest } from './anthropic-client.js'
import { loadSettings, resolveModelSelection, getProviderConfig, getDefaultMaxTokens } from './settings.js'
import type { Message, StreamEvent, ModelConfig, ProviderConfig } from './types.js'
import type { ToolDefinition } from './tool.js'

describe('buildAnthropicRequest cache_control', () => {
  const messages: Message[] = [
    { role: 'user', id: 'm-a', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', id: 'm-b', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', id: 'm-c', content: [{ type: 'text', text: 'c' }] },
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

  it('maps image block → SDK image block (mediaType → media_type)', () => {
    const withImage: Message[] = [
      {
        role: 'user',
        id: 'm-image',
        content: [
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'describe this' },
        ],
      },
    ]
    const req = buildAnthropicRequest(withImage, { model: 'm', max_tokens: 10 })
    const msgs = req.messages as unknown as Array<{ content: Array<Record<string, unknown>> }>
    expect(msgs[0]!.content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    })
  })
})

// ——— 瞬时错误自动重试(Phase 11 故障注入,镜像 OpenAIClient 的同名测试组)———
// AnthropicClient 的重试/守卫循环与 OpenAIClient 是各自一份的镜像实现,
// 这里用注入的假 SDK 锁住同样的行为契约。

const FAKE_PROVIDER: ProviderConfig = { id: 'p', protocol: 'anthropic', apiKey: 'k', models: ['m'] }
const FAKE_CFG: ModelConfig = { model: 'm', max_tokens: 16 }
const FAKE_MSGS: Message[] = [{ role: 'user', id: 'm-fake', content: [{ type: 'text', text: 'hi' }] }]

/** 一组干净收尾的 Anthropic 流事件 + finalMessage(无工具,end_turn)。 */
function okAnthropicStream(): unknown {
  const events = [
    { type: 'message_start', message: { id: 'a1', model: 'claude-x' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]
  return Object.assign(
    (async function* () {
      for (const e of events) yield e
    })(),
    {
      finalMessage: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    },
  )
}

/** 注入用假 SDK:messages.stream 把行为委托给 impl(可抛错/可返回流)。 */
function fakeAnthropicSdk(impl: (signal: AbortSignal) => unknown): Anthropic {
  return {
    messages: {
      stream: (_params: unknown, opts: { signal: AbortSignal }) => impl(opts.signal),
    },
  } as unknown as Anthropic
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('AnthropicClient.sendMessages —— 瞬时错误自动重试', () => {
  it('首次 stream() 抛 429、第二次返回正常流：透明重试成功，无 error 事件', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1'
    try {
      let calls = 0
      const sdk = fakeAnthropicSdk(() => {
        calls++
        if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 })
        return okAnthropicStream()
      })
      const client = new AnthropicClient(FAKE_PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(FAKE_MSGS, FAKE_CFG))
      expect(calls).toBe(2)
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(events[0]).toMatchObject({ type: 'message-start', id: 'a1' })
      expect(events.some((e) => e.type === 'text-delta')).toBe(true)
      const stop = events.find((e) => e.type === 'message-stop') as Extract<StreamEvent, { type: 'message-stop' }>
      expect(stop.stop_reason).toBe('end_turn')
      expect(stop.usage.input_tokens).toBe(4)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
  })

  it('已产出首个事件后才断流：不重试，一次 message-start 后一个 error，stream 仅调用一次', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1'
    try {
      let calls = 0
      const sdk = fakeAnthropicSdk(() => {
        calls++
        return (async function* () {
          yield { type: 'message_start', message: { id: 'a2', model: 'claude-x' } }
          throw Object.assign(new Error('mid-stream 500'), { status: 500 })
        })()
      })
      const client = new AnthropicClient(FAKE_PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(FAKE_MSGS, FAKE_CFG))
      expect(calls).toBe(1) // 中途失败绝不重试(重试会重复 message-start/文本)
      expect(events.filter((e) => e.type === 'message-start')).toHaveLength(1)
      expect(events.some((e) => e.type === 'error')).toBe(true)
      expect(events.some((e) => e.type === 'message-stop')).toBe(false)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
  })

  it('不可重试错误（401）直接产出 error 带分类，不重试', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1'
    try {
      let calls = 0
      const sdk = fakeAnthropicSdk(() => {
        calls++
        throw Object.assign(new Error('unauthorized'), { status: 401 })
      })
      const client = new AnthropicClient(FAKE_PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(FAKE_MSGS, FAKE_CFG))
      expect(calls).toBe(1)
      const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
      expect(err).toBeTruthy()
      expect(err.category).toBe('auth')
      expect(err.status).toBe(401)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
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
    const messages: Message[] = [{ role: 'user', id: 'm-live', content: [{ type: 'text', text: 'Say exactly: hello world' }] }]
    const events: StreamEvent[] = []
    for await (const e of client.sendMessages(messages, { model: sel.model, max_tokens: getDefaultMaxTokens(settings) })) {
      events.push(e)
    }
    expect(events.find((e) => e.type === 'message-start')).toBeTruthy()
    expect(events.find((e) => e.type === 'message-stop')).toBeTruthy()
  }, 15_000)
})
