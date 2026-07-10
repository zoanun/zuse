import { describe, it, expect } from 'vitest'
import { applyUserStamp, stripUserStamp } from './userStamp.js'

describe('userStamp', () => {
  it('applyUserStamp emits local time + explicit offset and round-trips', () => {
    const out = applyUserStamp('hello')
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}\] hello$/)
    expect(stripUserStamp(out)).toBe('hello')
  })

  it('uses the LOCAL wall-clock hour, not the UTC hour (the +8 bug)', () => {
    const at = new Date('2026-07-10T00:00:00Z') // UTC midnight; on +8 the local hour is 08
    const out = applyUserStamp('x', at)
    const localHH = String(at.getHours()).padStart(2, '0')
    expect(out).toContain(` ${localHH}:`) // matches local hour, would be "00" if impl used toISOString
  })

  it('strips the OLD offset-less stamp (backward compat with existing ledger)', () => {
    expect(stripUserStamp('[2026-06-26 12:34] hello')).toBe('hello')
  })

  it('strips the NEW stamp that carries an offset', () => {
    expect(stripUserStamp('[2026-07-10 20:58 +08:00] hi')).toBe('hi')
  })

  it('leaves a non-stamp leading bracket untouched', () => {
    expect(stripUserStamp('[not a stamp] text')).toBe('[not a stamp] text')
  })
})
