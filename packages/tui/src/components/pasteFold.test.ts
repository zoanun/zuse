import { describe, it, expect } from 'vitest'
import {
  PASTE_START,
  PASTE_END,
  tagLabel,
  foldPaste,
  expand,
  toDisplay,
  toDisplayCursor,
} from './pasteFold.js'
import { emptyBuffer } from './textBuffer.js'

describe('tagLabel', () => {
  it('行数=换行数+1,字数=字符数', () => {
    expect(tagLabel(1, 'a\nb\nc')).toBe('粘贴#1 · 3 行 · 5 字符')
  })
  it('字数 ≥1000 显示 x.xk', () => {
    expect(tagLabel(2, 'x'.repeat(1234))).toBe('粘贴#2 · 1 行 · 1.2k 字符')
  })
})

describe('foldPaste', () => {
  it('在光标处插入哨兵 span,id 自增,内容入 Map', () => {
    const r = foldPaste(emptyBuffer, new Map(), 1, 'a\nb')
    expect(r.buf.text).toBe(`\u{E000}1\u{E001}`)
    expect(r.buf.cursor).toBe(r.buf.text.length)
    expect(r.pastes.get(1)).toBe('a\nb')
    expect(r.nextId).toBe(2)
  })
  it('剥除内容里自带的哨兵字符', () => {
    const r = foldPaste(emptyBuffer, new Map(), 1, `a\u{E000}b\u{E001}\nc`)
    expect(r.pastes.get(1)).toBe('ab\nc')
  })
  it('在已有文本光标处插入', () => {
    const r = foldPaste({ text: 'xy', cursor: 1 }, new Map(), 3, 'p\nq')
    expect(r.buf.text).toBe(`x\u{E000}3\u{E001}y`)
  })
})

describe('expand', () => {
  it('span → 全文', () => {
    const pastes = new Map([[1, 'a\nb']])
    expect(expand(`X\u{E000}1\u{E001}Y`, pastes)).toBe('Xa\nbY')
  })
  it('未知 id 退化为字面', () => {
    expect(expand(`\u{E000}9\u{E001}`, new Map())).toBe(`\u{E000}9\u{E001}`)
  })
})

describe('toDisplay', () => {
  it('span → [标签]', () => {
    const pastes = new Map([[1, 'a\nb']])
    expect(toDisplay(`X\u{E000}1\u{E001}`, pastes)).toBe('X[粘贴#1 · 2 行 · 3 字符]')
  })
})

describe('toDisplayCursor', () => {
  const pastes = new Map([[1, 'a\nb']]) // label 长度固定
  const labelLen = `[粘贴#1 · 2 行 · 3 字符]`.length
  const text = `x\u{E000}1\u{E001}y` // x=0, span=[1,4), y=4
  it('光标在 span 前', () => {
    expect(toDisplayCursor(text, 1, pastes)).toBe(1)
  })
  it('光标在 span 后', () => {
    expect(toDisplayCursor(text, 4, pastes)).toBe(1 + labelLen)
  })
  it('光标在末尾', () => {
    expect(toDisplayCursor(text, 5, pastes)).toBe(1 + labelLen + 1)
  })
})
