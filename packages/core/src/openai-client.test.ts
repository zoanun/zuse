import { describe, it, expect } from 'vitest'
import type OpenAI from 'openai'
import { toOpenAIMessages, toOpenAITools, streamToEvents, OpenAIClient } from './openai-client.js'
import type { Message, StreamEvent, ModelConfig, ProviderConfig } from './types.js'
import type { ToolDefinition } from './tool.js'

describe('toOpenAIMessages', () => {
  it('prepends system, maps text, tool_use → tool_calls, tool_result → top-level tool message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    ]
    const out = toOpenAIMessages(messages, 'SYS')
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) } }],
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'file body' })
  })

  it('omits the system message when no system prompt', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], undefined)
    expect(out[0]).toEqual({ role: 'user', content: 'x' })
  })
})

describe('toOpenAITools', () => {
  it('maps input_schema → function.parameters', () => {
    const defs: ToolDefinition[] = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }]
    expect(toOpenAITools(defs)).toEqual([
      { type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: {} } } },
    ])
  })
})

// 把一串 chunk 包成异步可迭代，喂给 streamToEvents。
async function* feed(chunks: unknown[]): AsyncIterable<unknown> {
  for (const c of chunks) yield c
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('streamToEvents', () => {
  it('emits message-start, text-delta, message-stop(end_turn) with usage', async () => {
    const chunks = [
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: {}, finish_reason: 'stop' }] },
      { id: 'm1', model: 'deepseek-chat', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    expect(events[0]).toEqual({ type: 'message-start', id: 'm1', model: 'deepseek-chat' })
    expect(
      events
        .filter((e): e is Extract<StreamEvent, { type: 'text-delta' }> => e.type === 'text-delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello')
    const stop = events.find((e) => e.type === 'message-stop') as Extract<StreamEvent, { type: 'message-stop' }>
    expect(stop.stop_reason).toBe('end_turn')
    // prompt_tokens(12) 含缓存命中(8)；归一后 input_tokens = 12 - 8 = 4，缓存部分记入 cache_read。
    expect(stop.usage).toEqual({ input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 8 })
  })

  it('cached_tokens 超过 prompt_tokens（gptsapi 这类违规转发端）时 input_tokens 不为负', async () => {
    const chunks = [
      { id: 'm5', model: 'gpt-5.4', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5214, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 20000 } } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const stop = events.find((e) => e.type === 'message-stop') as Extract<StreamEvent, { type: 'message-stop' }>
    // cached(20000) > prompt(5214) 说明该端 prompt_tokens 不含缓存：直接当新输入，不再减，避免变负。
    expect(stop.usage).toEqual({ input_tokens: 5214, output_tokens: 100, cache_read_input_tokens: 20000 })
  })

  it('maps finish_reason "length" to "max_tokens" (不伪装成 end_turn)', async () => {
    const chunks = [
      { id: 'm3', model: 'x', choices: [{ delta: { content: 'half' }, finish_reason: null }] },
      { id: 'm3', model: 'x', choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 9 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const stop = events.find((e) => e.type === 'message-stop') as Extract<StreamEvent, { type: 'message-stop' }>
    expect(stop.stop_reason).toBe('max_tokens')
  })

  it('非法 JSON 参数串 → 带 invalid_args 的 tool-use,不中止回合（Phase 11 回喂自纠）', async () => {
    const chunks = [
      { id: 'm4', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'Bash', arguments: '{"cmd":' } }] }, finish_reason: null }] },
      { id: 'm4', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const use = events.find((e) => e.type === 'tool-use') as Extract<StreamEvent, { type: 'tool-use' }>
    // 不再 error 中止（那会连已流出的文本一起作废）；input 用 {} 占位保证可序列化重放，
    // 原始非法串放 invalid_args 供 Agent 合成回喂 observation。
    expect(use).toEqual({ type: 'tool-use', id: 'c0', name: 'Bash', input: {}, invalid_args: '{"cmd":' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const stop = events.find((e) => e.type === 'message-stop') as Extract<StreamEvent, { type: 'message-stop' }>
    expect(stop.stop_reason).toBe('tool_use')
  })

  it('非法参数且 id 缺失时合成兜底 id，保证 tool_use/tool_result 可配对', async () => {
    const chunks = [
      // 弱端点可能不回 tool_call id —— 首片只有 name 与参数片段。
      { id: 'm6', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Read', arguments: 'not-json' } }] }, finish_reason: null }] },
      { id: 'm6', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const use = events.find((e) => e.type === 'tool-use') as Extract<StreamEvent, { type: 'tool-use' }>
    expect(use.id).toBe('invalid-json-0')
    expect(use.invalid_args).toBe('not-json')
  })

  it('空参数串仍按 {} 处理（合法的无参调用，不带 invalid_args）', async () => {
    const chunks = [
      { id: 'm7', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'ListTools', arguments: '' } }] }, finish_reason: null }] },
      { id: 'm7', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const use = events.find((e) => e.type === 'tool-use') as Extract<StreamEvent, { type: 'tool-use' }>
    expect(use).toEqual({ type: 'tool-use', id: 'c0', name: 'ListTools', input: {} })
  })

  it('accumulates fragmented tool_call arguments by index and emits tool-use before stop', async () => {
    const chunks = [
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'Bash', arguments: '{"cmd":' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const uses = events.filter((e): e is Extract<StreamEvent, { type: 'tool-use' }> => e.type === 'tool-use')
    expect(uses).toEqual([
      { type: 'tool-use', id: 'c0', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool-use', id: 'c1', name: 'Read', input: { file_path: '/a' } },
    ])
    const stopIdx = events.findIndex((e) => e.type === 'message-stop')
    const lastUseIdx = events.map((e) => e.type).lastIndexOf('tool-use')
    expect(lastUseIdx).toBeLessThan(stopIdx) // tool-use 必须在 message-stop 之前
    expect((events[stopIdx] as Extract<StreamEvent, { type: 'message-stop' }>).stop_reason).toBe('tool_use')
  })
})

// ——— sendMessages 的中断/空闲超时接线 ———

const PROVIDER: ProviderConfig = { id: 'p', protocol: 'openai', apiKey: 'k', models: ['m'] }
const CFG: ModelConfig = { model: 'm', max_tokens: 16 }
const MSGS: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

/**
 * 模拟 SDK 的流：先吐 firstChunks，然后挂起，直到传入的 signal 被 abort 才以 AbortError 抛出
 *（复刻真实 SDK 下 fetch 被 abort、异步迭代器随之报错的行为）。
 */
function abortAwareStream(signal: AbortSignal, firstChunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of firstChunks) yield c
      await new Promise<void>((_, reject) => {
        const fail = (): void => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }))
        if (signal.aborted) return fail()
        signal.addEventListener('abort', fail, { once: true })
      })
    },
  }
}

/** 构造一个注入用的假 OpenAI SDK：create 把收到的 signal 交给 makeStream 并记录下来。 */
function fakeSdk(
  makeStream: (signal: AbortSignal) => AsyncIterable<unknown>,
  onSignal?: (s: AbortSignal) => void,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (_body: unknown, opts: { signal: AbortSignal }) => {
          onSignal?.(opts.signal)
          return makeStream(opts.signal)
        },
      },
    },
  } as unknown as OpenAI
}

describe('OpenAIClient.sendMessages —— 中断与空闲超时', () => {
  it('流空闲超过阈值时产出明确的超时 error，而非永久挂起', async () => {
    process.env.ZUSE_STREAM_IDLE_MS = '30'
    try {
      const sdk = fakeSdk((sig) => abortAwareStream(sig, [{ id: 'x', model: 'm', choices: [] }]))
      const client = new OpenAIClient(PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(MSGS, CFG))
      const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }> | undefined
      expect(err).toBeTruthy()
      expect(err!.message).toContain('空闲')
      // 首块已开流，故 message-start 应已产出；但不应有 message-stop（流被中断）。
      expect(events.some((e) => e.type === 'message-start')).toBe(true)
      expect(events.some((e) => e.type === 'message-stop')).toBe(false)
    } finally {
      delete process.env.ZUSE_STREAM_IDLE_MS
    }
  })

  it('外部 Esc 信号接到底层 SDK 请求：abort 后流解除阻塞并产出 error', async () => {
    let captured: AbortSignal | undefined
    const sdk = fakeSdk(
      (sig) => abortAwareStream(sig, [{ id: 'x', model: 'm', choices: [] }]),
      (s) => {
        captured = s
      },
    )
    const ext = new AbortController()
    const client = new OpenAIClient(PROVIDER, 'm', sdk)
    const iter = client.sendMessages(MSGS, CFG, undefined, ext.signal)[Symbol.asyncIterator]()

    const first = await iter.next() // message-start（消费首块后流挂起）
    expect(first.value).toMatchObject({ type: 'message-start' })
    expect(captured).toBeDefined()
    expect(captured!.aborted).toBe(false)

    ext.abort() // 用户按 Esc

    const rest: StreamEvent[] = []
    for (;;) {
      const r = await iter.next()
      if (r.done) break
      rest.push(r.value)
    }
    expect(captured!.aborted).toBe(true) // 外部中断已传导到 SDK 请求
    expect(rest.some((e) => e.type === 'error')).toBe(true)
  })
})

// ——— sendMessages 的瞬时错误自动重试 ———

// 一个不会挂起的正常流：吐若干 chunk 后自然结束（不依赖 signal）。
async function* plainStream(chunks: unknown[]): AsyncIterable<unknown> {
  for (const c of chunks) yield c
}

const OK_CHUNKS: unknown[] = [
  { id: 'r1', model: 'm', choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
  { id: 'r1', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
]

describe('OpenAIClient.sendMessages —— 瞬时错误自动重试', () => {
  it('首次尝试 create 抛 429、第二次返回正常流：透明重试成功，无 error 事件', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1' // 退避缩到 ~1ms，测试快速完成。
    try {
      let calls = 0
      const sdk = {
        chat: {
          completions: {
            create: async (_body: unknown, _opts: { signal: AbortSignal }) => {
              calls++
              if (calls === 1) {
                // 复刻 SDK 的限流错误：带 status=429。
                throw Object.assign(new Error('rate limited'), { status: 429 })
              }
              return plainStream(OK_CHUNKS)
            },
          },
        },
      } as unknown as OpenAI
      const client = new OpenAIClient(PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(MSGS, CFG))
      expect(calls).toBe(2) // 第一次失败、第二次成功
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(events[0]).toMatchObject({ type: 'message-start' })
      expect(events.some((e) => e.type === 'text-delta')).toBe(true)
      expect(events.some((e) => e.type === 'message-stop')).toBe(true)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
  })

  it('已产出首个事件后才报错：不重试，产出一次 message-start 后一个 error，create 仅调用一次', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1'
    try {
      let calls = 0
      // 流：先吐一块（触发 message-start），再在迭代中途抛一个可重试错误（429）。
      async function* midThrow(): AsyncIterable<unknown> {
        yield { id: 'r2', model: 'm', choices: [{ delta: { content: 'partial' }, finish_reason: null }] }
        throw Object.assign(new Error('mid-stream 500'), { status: 500 })
      }
      const sdk = {
        chat: {
          completions: {
            create: async (_body: unknown, _opts: { signal: AbortSignal }) => {
              calls++
              return midThrow()
            },
          },
        },
      } as unknown as OpenAI
      const client = new OpenAIClient(PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(MSGS, CFG))
      expect(calls).toBe(1) // 中途失败绝不重试
      expect(events.filter((e) => e.type === 'message-start')).toHaveLength(1)
      expect(events.some((e) => e.type === 'error')).toBe(true)
      // 中途断流不应产出 message-stop。
      expect(events.some((e) => e.type === 'message-stop')).toBe(false)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
  })

  it('不可重试错误（401）直接产出 error，不重试', async () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    process.env.ZUSE_RETRY_BASE_MS = '1'
    try {
      let calls = 0
      const sdk = {
        chat: {
          completions: {
            create: async (_body: unknown, _opts: { signal: AbortSignal }) => {
              calls++
              throw Object.assign(new Error('unauthorized'), { status: 401 })
            },
          },
        },
      } as unknown as OpenAI
      const client = new OpenAIClient(PROVIDER, 'm', sdk)
      const events = await collect(client.sendMessages(MSGS, CFG))
      expect(calls).toBe(1)
      expect(events.some((e) => e.type === 'error')).toBe(true)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
      delete process.env.ZUSE_RETRY_BASE_MS
    }
  })
})

describe('OpenAIClient.sendMessages —— 错误分类透出', () => {
  it('开流即报 402:error 事件带 category=quota、status=402', async () => {
    // 402 不可重试,立即透出;makeStream 抛错 → create reject → client 捕获后分类。
    const sdk = fakeSdk(() => {
      throw Object.assign(new Error('insufficient balance'), { status: 402 })
    })
    const client = new OpenAIClient(PROVIDER, 'm', sdk)
    const events = await collect(client.sendMessages(MSGS, CFG))
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.category).toBe('quota')
    expect(err.status).toBe(402)
  })

  it('401 透出 category=auth', async () => {
    const sdk = fakeSdk(() => {
      throw Object.assign(new Error('invalid key'), { status: 401 })
    })
    const client = new OpenAIClient(PROVIDER, 'm', sdk)
    const events = await collect(client.sendMessages(MSGS, CFG))
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err.category).toBe('auth')
  })
})
