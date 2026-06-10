import { describe, it, expect } from 'vitest'
import { parsedKeyToInkKey } from './parsedKeyToInkKey.js'
import { parseKeypress } from './parseKeypress.js'

describe('parsedKeyToInkKey', () => {
  it('回车:key.return=true,input 为空', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\r'))
    expect(key.return).toBe(true)
    expect(key.shift).toBe(false)
    expect(input).toBe('')
  })

  it('Shift+Enter(CSI u):return + shift', () => {
    const { key } = parsedKeyToInkKey(parseKeypress('\x1b[13;2u'))
    expect(key.return).toBe(true)
    expect(key.shift).toBe(true)
  })

  it('裸 LF:映射为 input=\\n(走换行兜底)', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\n'))
    expect(input).toBe('\n')
    expect(key.return).toBe(false)
  })

  it('方向上:key.upArrow=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[A')).key.upArrow).toBe(true)
  })

  it('退格:key.backspace=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x7f')).key.backspace).toBe(true)
  })

  it('Tab:key.tab=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\t')).key.tab).toBe(true)
  })

  it('Escape:key.escape=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b')).key.escape).toBe(true)
  })

  it('Ctrl+C:input=c 且 ctrl=true', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\x03'))
    expect(input).toBe('c')
    expect(key.ctrl).toBe(true)
  })

  it('Ctrl+A:input=a 且 ctrl=true(供 keyToEvent 映射行首)', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\x01'))
    expect(input).toBe('a')
    expect(key.ctrl).toBe(true)
  })

  it('空格:input=单空格', () => {
    expect(parsedKeyToInkKey(parseKeypress(' ')).input).toBe(' ')
  })

  it('可打印字母:input 为该字符(大写保留)', () => {
    expect(parsedKeyToInkKey(parseKeypress('h')).input).toBe('h')
    expect(parsedKeyToInkKey(parseKeypress('H')).input).toBe('H')
  })

  it('VSCode 旧兜底 ESC+CR:映射为换行 input=\\n', () => {
    // 构造一个 sequence 为 \x1b\r 的 ParsedKey(parseKeypress 对它 name 留空)
    const { input } = parsedKeyToInkKey(parseKeypress('\x1b\r'))
    expect(input).toBe('\n')
  })

  it('粘贴 key:整段内容作为 input 文本(本期纯文本插入)', () => {
    const pasted = {
      kind: 'key' as const,
      name: '',
      fn: false,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      sequence: 'line1\nline2',
      raw: 'line1\nline2',
      isPasted: true,
    }
    expect(parsedKeyToInkKey(pasted).input).toBe('line1\nline2')
  })

  it('方向下:key.downArrow=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[B')).key.downArrow).toBe(true)
  })
  it('方向左:key.leftArrow=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[D')).key.leftArrow).toBe(true)
  })
  it('方向右:key.rightArrow=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[C')).key.rightArrow).toBe(true)
  })
  it('Delete:key.delete=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[3~')).key.delete).toBe(true)
  })
  it('Alt+字母:key.meta=true,ctrl=false', () => {
    const { key } = parsedKeyToInkKey(parseKeypress('\x1ba'))
    expect(key.meta).toBe(true)
    expect(key.ctrl).toBe(false)
  })
  it('Ctrl+E:input=e 且 ctrl=true(供 keyToEvent 映射行尾)', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\x05'))
    expect(input).toBe('e')
    expect(key.ctrl).toBe(true)
  })
})
