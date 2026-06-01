import { describe, it, expect } from 'vitest'
import { Conversation } from './conversation.js'

describe('Conversation', () => {
  it('appends user/assistant turns in order', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.appendAssistantText('hello')
    const msgs = c.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(msgs[1]?.role).toBe('assistant')
  })

  it('getMessages returns a defensive copy', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    const msgs = c.getMessages()
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'mutated' }] })
    expect(c.length).toBe(1)
  })

  it('accumulates usage across turns', () => {
    const c = new Conversation()
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.addUsage({ input_tokens: 20, output_tokens: 7 })
    expect(c.totalUsage).toEqual({ input_tokens: 30, output_tokens: 12 })
  })

  it('clear() resets messages and usage', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.clear()
    expect(c.length).toBe(0)
    expect(c.totalUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
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
      // @ts-expect-error testing runtime guard with a bad version
      Conversation.fromJSON({ version: 2, messages: [], totalUsage: { input_tokens: 0, output_tokens: 0 } }),
    ).toThrow()
  })
})
