import { describe, it, expect } from 'vitest'
import type { SessionEvent } from './events.js'

describe('SessionEvent', () => {
  it('events serialize to JSON without loss (no functions/class instances)', () => {
    const e: SessionEvent = { type: 'text-delta', text: 'hi' }
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })
  it('permission-request carries id and request', () => {
    const e: SessionEvent = {
      type: 'permission-request',
      id: 'p1',
      req: { toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' },
    }
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })
})
