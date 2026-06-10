import { describe, it, expect } from 'vitest'
import { createTokenizer } from './tokenize.js'

describe('createTokenizer.feed', () => {
  it('纯文本原样成一个 text token', () => {
    const t = createTokenizer()
    expect(t.feed('hello')).toEqual([{ type: 'text', value: 'hello' }])
  })

  it('文本 + 完整 CSI 序列切成 text + sequence', () => {
    const t = createTokenizer()
    expect(t.feed('ab\x1b[A')).toEqual([
      { type: 'text', value: 'ab' },
      { type: 'sequence', value: '\x1b[A' },
    ])
  })

  it('PASTE_START / PASTE_END 各自作为独立 sequence 吐出(不聚合)', () => {
    const t = createTokenizer()
    const tokens = t.feed('\x1b[200~hi\x1b[201~')
    expect(tokens).toEqual([
      { type: 'sequence', value: '\x1b[200~' },
      { type: 'text', value: 'hi' },
      { type: 'sequence', value: '\x1b[201~' },
    ])
  })
})

describe('跨 chunk 半截序列缓冲', () => {
  it('CSI 被切成两块,第二块补齐后才吐出完整序列', () => {
    const t = createTokenizer()
    expect(t.feed('x\x1b[')).toEqual([{ type: 'text', value: 'x' }])
    expect(t.buffer()).toBe('\x1b[')
    expect(t.feed('A')).toEqual([{ type: 'sequence', value: '\x1b[A' }])
    expect(t.buffer()).toBe('')
  })

  it('flush 把未完成序列强制吐出', () => {
    const t = createTokenizer()
    t.feed('\x1b[')
    expect(t.flush()).toEqual([{ type: 'sequence', value: '\x1b[' }])
  })
})

describe('其余转义状态(冒烟)', () => {
  it('OSC 以 BEL 结束 → 整段一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1b]0;title\x07')).toEqual([
      { type: 'sequence', value: '\x1b]0;title\x07' },
    ])
  })

  it('OSC 以 ESC ST 结束 → 整段一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1b]0;t\x1b\\')).toEqual([
      { type: 'sequence', value: '\x1b]0;t\x1b\\' },
    ])
  })

  it('SS3 功能键 ESC O A → 一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1bOA')).toEqual([{ type: 'sequence', value: '\x1bOA' }])
  })

  it('DCS 以 ESC ST 结束 → 一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1bPdata\x1b\\')).toEqual([
      { type: 'sequence', value: '\x1bPdata\x1b\\' },
    ])
  })

  it('APC 以 ESC ST 结束 → 一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1b_data\x1b\\')).toEqual([
      { type: 'sequence', value: '\x1b_data\x1b\\' },
    ])
  })

  it('escapeIntermediate(字符集 ESC ( B)→ 一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1b(B')).toEqual([{ type: 'sequence', value: '\x1b(B' }])
  })

  it('两字符 ESC(ESC M 反向换行)→ 一个 sequence', () => {
    const t = createTokenizer()
    expect(t.feed('\x1bM')).toEqual([{ type: 'sequence', value: '\x1bM' }])
  })

  it('连续两个 ESC:先吐出前一个,再吐出后续 CSI', () => {
    const t = createTokenizer()
    expect(t.feed('\x1b\x1b[A')).toEqual([
      { type: 'sequence', value: '\x1b' },
      { type: 'sequence', value: '\x1b[A' },
    ])
  })

  it('reset() 清空半截缓冲', () => {
    const t = createTokenizer()
    t.feed('\x1b[')
    expect(t.buffer()).toBe('\x1b[')
    t.reset()
    expect(t.buffer()).toBe('')
    expect(t.feed('A')).toEqual([{ type: 'text', value: 'A' }])
  })
})
