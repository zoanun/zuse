import { describe, it, expect } from 'vitest'
import { splitPasteLabels } from './pasteLabels.js'

describe('splitPasteLabels', () => {
  it('无标签：整行一段', () => {
    expect(splitPasteLabels('hello world')).toEqual([{ text: 'hello world' }])
  })
  it('单标签：切出 id', () => {
    expect(splitPasteLabels('前[粘贴#1 · 3 行 · 9 字符]后')).toEqual([
      { text: '前' },
      { text: '[粘贴#1 · 3 行 · 9 字符]', id: 1 },
      { text: '后' },
    ])
  })
  it('多标签', () => {
    const segs = splitPasteLabels('[粘贴#1 · 2 行 · 3 字符][粘贴#2 · 5 行 · 1.0k 字符]')
    expect(segs.map((s) => s.id)).toEqual([1, 2])
  })
  it('空字符串：返回空文本段', () => {
    expect(splitPasteLabels('')).toEqual([{ text: '' }])
  })
  it('仅标签无前后文本', () => {
    const segs = splitPasteLabels('[粘贴#3 · 10 行 · 2.5k 字符]')
    expect(segs).toEqual([{ text: '[粘贴#3 · 10 行 · 2.5k 字符]', id: 3 }])
  })
})
