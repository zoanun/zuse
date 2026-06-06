import { describe, it, expect } from 'vitest'
import { toOpenAIMessages, toOpenAITools, streamToEvents } from './openai-client.js'
import type { Message, StreamEvent } from './types.js'
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

  it('emits an error (not a {} tool-use) when tool_call arguments are non-empty but invalid JSON', async () => {
    const chunks = [
      { id: 'm4', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'Bash', arguments: '{"cmd":' } }] }, finish_reason: null }] },
      { id: 'm4', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    expect(events.some((e) => e.type === 'tool-use')).toBe(false)
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.message).toContain('Bash')
    // error 后中止，不再产出 message-stop。
    expect(events.some((e) => e.type === 'message-stop')).toBe(false)
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
