import { describe, it, expect } from 'vitest'
import { Conversation, genMsgId } from './conversation.js'

describe('Conversation', () => {
  it('appends user/assistant turns in order', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.appendAssistantText('hello')
    const msgs = c.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[0]?.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(typeof msgs[0]?.id).toBe('string')
    expect(msgs[1]?.role).toBe('assistant')
  })

  it('getMessages returns a defensive copy', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    const msgs = c.getMessages()
    msgs.push({ role: 'user', id: genMsgId(), content: [{ type: 'text', text: 'mutated' }] })
    expect(c.length).toBe(1)
  })

  it('accumulates usage across turns', () => {
    const c = new Conversation()
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.addUsage({ input_tokens: 20, output_tokens: 7 })
    // Phase 6 起 totalUsage 始终含 cache 字段（值为 0 时也会出现）。
    expect(c.totalUsage).toEqual({ input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('clear() resets messages and usage', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.clear()
    expect(c.length).toBe(0)
    // Phase 6 起 totalUsage 始终含 cache 字段。
    expect(c.totalUsage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('round-trips through toJSON/fromJSON', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.appendAssistantText('hello')
    c.addUsage({ input_tokens: 9, output_tokens: 20 })
    const restored = Conversation.fromJSON(c.toJSON())
    expect(restored.getMessages()).toEqual(c.getMessages())
    expect(restored.totalUsage).toEqual(c.totalUsage)
  })

  it('fromJSON throws on unknown version', () => {
    expect(() =>
      Conversation.fromJSON({
        // @ts-expect-error 故意传一个错误的 version 来测试运行时校验
        version: 2,
        messages: [],
        totalUsage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toThrow()
  })
})

describe('addUsage cache fields', () => {
  it('accumulates cache_read and cache_creation across turns', () => {
    const conv = new Conversation()
    conv.addUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })
    conv.addUsage({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50 })
    const u = conv.totalUsage
    expect(u.input_tokens).toBe(13)
    expect(u.output_tokens).toBe(7)
    expect(u.cache_read_input_tokens).toBe(150)
    expect(u.cache_creation_input_tokens).toBe(20)
  })

  it('treats missing cache fields as zero', () => {
    const conv = new Conversation()
    conv.addUsage({ input_tokens: 1, output_tokens: 1 })
    expect(conv.totalUsage.cache_read_input_tokens).toBe(0)
    expect(conv.totalUsage.cache_creation_input_tokens).toBe(0)
  })
})

describe('message id', () => {
  it('fromJSON 给缺 id 的 legacy 消息按下标赋确定性 id，二次加载不变', () => {
    const legacy = {
      version: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
      ],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    }
    const a = Conversation.fromJSON(legacy as never).getMessages()
    const b = Conversation.fromJSON(legacy as never).getMessages()
    expect(a[0]!.id).toBe('msg_legacy_0')
    expect(a[1]!.id).toBe('msg_legacy_1')
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id))
  })

  it('genMsgId 唯一带前缀', () => {
    expect(genMsgId()).toMatch(/^msg_/)
    expect(genMsgId()).not.toBe(genMsgId())
  })

  it('append 拒绝无 id 消息', () => {
    expect(() => new Conversation().append({ role: 'user', content: [] } as never)).toThrow(/missing id/)
  })
})
