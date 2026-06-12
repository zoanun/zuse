import { describe, it, expect } from 'vitest'
import {
  parseKeypress,
  parseMultipleKeypresses,
  INITIAL_STATE,
} from './parseKeypress.js'

describe('parseKeypress 基础键', () => {
  it('回车 \\r → name=return', () => {
    const k = parseKeypress('\r')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(false)
  })

  it('裸 LF \\n → name=enter', () => {
    expect(parseKeypress('\n').name).toBe('enter')
  })

  it('退格 \\x7f → name=backspace', () => {
    expect(parseKeypress('\x7f').name).toBe('backspace')
  })

  it('方向上 \\x1b[A → name=up', () => {
    expect(parseKeypress('\x1b[A').name).toBe('up')
  })

  it('Ctrl+C \\x03 → name=c, ctrl=true', () => {
    const k = parseKeypress('\x03')
    expect(k.name).toBe('c')
    expect(k.ctrl).toBe(true)
  })

  it('小写字母透传,大写带 shift', () => {
    expect(parseKeypress('h').name).toBe('h')
    const up = parseKeypress('H')
    expect(up.name).toBe('h')
    expect(up.shift).toBe(true)
  })
})

describe('Shift+Enter 两条协议路径', () => {
  it('Kitty CSI u:ESC[13;2u → return + shift', () => {
    const k = parseKeypress('\x1b[13;2u')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(true)
    expect(k.ctrl).toBe(false)
  })

  it('CSI u 无修饰:ESC[27u → escape', () => {
    expect(parseKeypress('\x1b[27u').name).toBe('escape')
  })

  it('modifyOtherKeys:ESC[27;2;13~ → return + shift', () => {
    const k = parseKeypress('\x1b[27;2;13~')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(true)
  })

  it('Kitty CSI u Ctrl+C:ESC[99;5u → name=c, ctrl=true', () => {
    const k = parseKeypress('\x1b[99;5u')
    expect(k.name).toBe('c')
    expect(k.ctrl).toBe(true)
    expect(k.shift).toBe(false)
  })
})

describe('parseMultipleKeypresses 粘贴聚合', () => {
  it('单块粘贴:PASTE_START..PASTE_END 聚合为一个 isPasted key', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~hello\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('hello')
  })

  it('跨 chunk 粘贴:内容被切成两块,补齐后才吐出', () => {
    let [keys, st] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~hel')
    expect(keys).toEqual([])
    ;[keys, st] = parseMultipleKeypresses(st, 'lo\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('hello')
  })

  it('粘贴内容含换行:多行原样保留', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~a\nb\nc\x1b[201~')
    expect(keys[0]!.sequence).toBe('a\nb\nc')
  })

  it('粘贴内容把 CR / CRLF 规范为 LF(否则裸 \\r 会污染渲染)', () => {
    const [crlf] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~a\r\nb\x1b[201~')
    expect(crlf[0]!.sequence).toBe('a\nb')
    const [cr] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~a\rb\x1b[201~')
    expect(cr[0]!.sequence).toBe('a\nb')
  })

  it('空粘贴也产出一个 isPasted key(供将来图片侦测)', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('')
  })

  it('两字符文本块整体作为一个 key(name 为空,序列保留)', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'hi')
    expect(keys.length).toBe(1)
    expect(keys[0]!.sequence).toBe('hi')
    expect(keys[0]!.isPasted).toBe(false)
  })
})

describe('parseMultipleKeypresses flush(传 null)', () => {
  it('粘贴中途 flush:吐出已累积的内容', () => {
    const [pending, st] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~partial')
    expect(pending).toEqual([])
    const [keys] = parseMultipleKeypresses(st, null)
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('partial')
  })

  it('flush 半截转义序列:强制吐出,不吞字符', () => {
    const [pending, st] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[')
    expect(pending).toEqual([])
    const [keys] = parseMultipleKeypresses(st, null)
    expect(keys.length).toBe(1)
    expect(keys[0]!.sequence).toBe('\x1b[')
  })
})
