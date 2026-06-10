import { describe, it, expect } from 'vitest'
import {
  PASTE_START,
  PASTE_END,
  tagLabel,
  foldPaste,
  expand,
  toDisplay,
  toDisplayCursor,
  pasteReduce,
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
  it('toDisplayCursor 多 span:光标在两 span 之间', () => {
    const pastes2 = new Map([[1, 'a\nb'], [2, 'c\nd']])
    const text2 = `x${PASTE_START}1${PASTE_END}y${PASTE_START}2${PASTE_END}z`
    const l1 = `[粘贴#1 · 2 行 · 3 字符]`.length
    // 光标在位置 5:x(1) + span1(3) + y(1) = 5,即 y 后、span2 前
    expect(toDisplayCursor(text2, 5, pastes2)).toBe(1 + l1 + 1) // x + [label1] + y
  })
})

const P = (id: number) => `${PASTE_START}${id}${PASTE_END}`

describe('pasteReduce 原子编辑', () => {
  // 文本 `x{span1}y`:x=0, span=[1,4), y=4, len=5
  const base = { text: `x${P(1)}y`, cursor: 5 }
  const pastes = new Map([[1, 'a\nb']])

  it('左移:从 span 后整体跨到 span 前', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 4 }, pastes, { type: 'left' })
    expect(r.buf.cursor).toBe(1)
  })
  it('右移:从 span 前整体跨到 span 后', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'right' })
    expect(r.buf.cursor).toBe(4)
  })
  it('退格:光标紧跟 span END 时整块删并剪除 id', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 4 }, pastes, { type: 'backspace' })
    expect(r.buf.text).toBe('xy')
    expect(r.buf.cursor).toBe(1)
    expect(r.pastes.has(1)).toBe(false)
  })
  it('向后删:光标正处 span START 时整块删并剪除 id', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'delete' })
    expect(r.buf.text).toBe('xy')
    expect(r.buf.cursor).toBe(1)
    expect(r.pastes.has(1)).toBe(false)
  })
  it('普通退格不误伤 span', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'backspace' })
    expect(r.buf.text).toBe(`${P(1)}y`)
    expect(r.pastes.has(1)).toBe(true)
  })
  it('插入字符不碰 span,Map 不变', () => {
    const r = pasteReduce(base, pastes, { type: 'insert', text: 'z' })
    expect(r.buf.text).toBe(`x${P(1)}yz`)
    expect(r.pastes.get(1)).toBe('a\nb')
  })
  it('submit/none 原样返回 buf', () => {
    expect(pasteReduce(base, pastes, { type: 'submit' }).buf).toEqual(base)
  })
  it('删一个 span 后,另一个 span 的 id 仍保留', () => {
    const text = `${P(1)}x${P(2)}` // span1=[0,3), x=3, span2=[4,7)
    const pastes2 = new Map([[1, 'a\nb'], [2, 'c\nd']])
    // 光标在 span1 END 之后(=3),退格删 span1
    const r = pasteReduce({ text, cursor: 3 }, pastes2, { type: 'backspace' })
    expect(r.pastes.has(1)).toBe(false)
    expect(r.pastes.has(2)).toBe(true)
    expect(r.buf.text).toBe(`x${P(2)}`)
  })
})
