import { describe, it, expect } from 'vitest'
import type { StreamEvent } from './types.js'
import type { ModelClient } from './model-client.js'
import { generateSessionTitle } from './title.js'
import { resolveSmallModelSelection } from './settings.js'
import type { ResolvedSettings } from './types.js'

function fakeClient(events: StreamEvent[]): ModelClient {
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      for (const e of events) yield e
    },
  }
}
const stop: StreamEvent = { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }

describe('generateSessionTitle', () => {
  it('collects streamed text into a title', async () => {
    const client = fakeClient([{ type: 'text-delta', text: '重构登录' }, { type: 'text-delta', text: '模块' }, stop])
    expect(await generateSessionTitle(client, 'fake', '帮我重构登录模块的代码')).toBe('重构登录模块')
  })

  it('strips wrapping quotes, a "标题:" prefix, and trailing punctuation', async () => {
    const client = fakeClient([{ type: 'text-delta', text: '标题：“修复缓存 bug。”' }, stop])
    expect(await generateSessionTitle(client, 'fake', 'x')).toBe('修复缓存 bug')
  })

  it('takes the first non-empty line when the model rambles', async () => {
    const client = fakeClient([{ type: 'text-delta', text: '\n部署脚本重写\n(这是我的理由...)' }, stop])
    expect(await generateSessionTitle(client, 'fake', 'x')).toBe('部署脚本重写')
  })

  it('returns null on an error event', async () => {
    const client = fakeClient([{ type: 'text-delta', text: 'x' }, { type: 'error', message: 'boom' }])
    expect(await generateSessionTitle(client, 'fake', 'hi')).toBeNull()
  })

  it('returns null when the model returns no text', async () => {
    expect(await generateSessionTitle(fakeClient([stop]), 'fake', 'hi')).toBeNull()
  })

  it('returns null for blank input without calling the model', async () => {
    let called = false
    const client: ModelClient = {
      getModel: () => 'fake',
      async *sendMessages() { called = true },
    }
    expect(await generateSessionTitle(client, 'fake', '   ')).toBeNull()
    expect(called).toBe(false)
  })

  it('truncates an over-long title to 60 chars', async () => {
    const long = 'x'.repeat(100)
    const client = fakeClient([{ type: 'text-delta', text: long }, stop])
    expect((await generateSessionTitle(client, 'fake', 'q'))?.length).toBe(60)
  })
})

describe('resolveSmallModelSelection', () => {
  const base = { providers: {}, tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] } } as unknown as ResolvedSettings

  it('returns null when smallModel is unset', () => {
    expect(resolveSmallModelSelection(base)).toBeNull()
  })

  it('splits only on the first slash, so a model name with slashes is kept whole', () => {
    expect(resolveSmallModelSelection({ ...base, smallModel: 'siliconflow/Qwen/Qwen2.5-7B-Instruct' }))
      .toEqual({ providerId: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct' })
  })

  it('treats a bare string as a default-provider model', () => {
    const sel = resolveSmallModelSelection({ ...base, smallModel: 'haiku' })
    expect(sel?.model).toBe('haiku')
  })
})
