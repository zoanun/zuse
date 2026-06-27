import { describe, it, expect } from 'vitest'
import { buildChatHtml } from './exportChat.js'
import type { Message } from './types.js'

describe('buildChatHtml', () => {
  it('keeps user text + rendered assistant markdown, drops think/tools/system', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'what is six times seven?' }] },
      { id: 'a1', role: 'assistant', parts: [
        { kind: 'text', text: '<think>secret reasoning</think>It is **42**.' },
        { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'echo' } },
      ] },
      { id: 'n1', role: 'system', parts: [{ kind: 'text', text: 'connection notice' }], noticeKind: 'info' },
    ]
    const html = buildChatHtml(messages, 'demo chat')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('what is six times seven?')
    expect(html).toContain('<strong>42</strong>')      // assistant markdown rendered to HTML
    expect(html).not.toContain('secret reasoning')      // <think> stripped
    expect(html).not.toContain('connection notice')     // system notices excluded
    expect(html).toContain('demo chat')                 // title
  })

  it('escapes HTML in user text', () => {
    const html = buildChatHtml([{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: '<script>alert(1)</script>' }] }])
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
