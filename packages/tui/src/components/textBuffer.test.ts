import { describe, it, expect } from 'vitest'
import {
  emptyBuffer,
  insert,
  backspace,
  deleteForward,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveBufferStart,
  moveBufferEnd,
  reduce,
  splitForRender,
} from './textBuffer.js'

describe('insert', () => {
  it('在空缓冲插入单字符，光标前移', () => {
    expect(insert(emptyBuffer, 'h')).toEqual({ text: 'h', cursor: 1 })
  })

  it('在光标处插入，文本与光标都更新', () => {
    expect(insert({ text: 'ac', cursor: 1 }, 'b')).toEqual({ text: 'abc', cursor: 2 })
  })

  it('插入换行符成为多行', () => {
    expect(insert({ text: 'ab', cursor: 2 }, '\n')).toEqual({ text: 'ab\n', cursor: 3 })
  })

  it('一次插入多字符（粘贴），光标按长度前移', () => {
    expect(insert(emptyBuffer, 'hello')).toEqual({ text: 'hello', cursor: 5 })
  })
})

describe('backspace', () => {
  it('删除光标前一个字符，光标后退', () => {
    expect(backspace({ text: 'abc', cursor: 2 })).toEqual({ text: 'ac', cursor: 1 })
  })

  it('光标在开头时为空操作', () => {
    expect(backspace({ text: 'abc', cursor: 0 })).toEqual({ text: 'abc', cursor: 0 })
  })

  it('可跨换行删除（合并两行）', () => {
    expect(backspace({ text: 'a\n', cursor: 2 })).toEqual({ text: 'a', cursor: 1 })
  })
})

describe('deleteForward', () => {
  it('删除光标处（后一个）字符，光标不动', () => {
    expect(deleteForward({ text: 'abc', cursor: 1 })).toEqual({ text: 'ac', cursor: 1 })
  })

  it('光标在末尾时为空操作', () => {
    expect(deleteForward({ text: 'abc', cursor: 3 })).toEqual({ text: 'abc', cursor: 3 })
  })

  it('可跨换行向后删（合并下一行）', () => {
    expect(deleteForward({ text: 'a\nb', cursor: 1 })).toEqual({ text: 'ab', cursor: 1 })
  })
})

// 用于移动测试的文本：'ab\ncd' —— a=0 b=1 \n=2 c=3 d=4，长度 5。
describe('moveLeft / moveRight', () => {
  it('左移在开头处停住', () => {
    expect(moveLeft({ text: 'ab\ncd', cursor: 0 }).cursor).toBe(0)
  })

  it('右移在末尾处停住', () => {
    expect(moveRight({ text: 'ab\ncd', cursor: 5 }).cursor).toBe(5)
  })

  it('左右移动跨越换行符（按偏移逐字符走）', () => {
    expect(moveLeft({ text: 'ab\ncd', cursor: 3 }).cursor).toBe(2)
    expect(moveRight({ text: 'ab\ncd', cursor: 2 }).cursor).toBe(3)
  })
})

describe('moveUp / moveDown', () => {
  it('上移到上一行的同列', () => {
    // 光标 4 = 第二行 'cd' 的列 1（d 前）；上移到第一行 'ab' 列 1（b 前）= 偏移 1。
    expect(moveUp({ text: 'ab\ncd', cursor: 4 }).cursor).toBe(1)
  })

  it('下移到下一行的同列', () => {
    expect(moveDown({ text: 'ab\ncd', cursor: 1 }).cursor).toBe(4)
  })

  it('目标行较短时，列被夹到行尾', () => {
    // 'abc\nd'：abc=0..2(起 0)，d 起 4。光标 2（列 2）下移到第二行 'd'（仅列 1）= 偏移 5。
    expect(moveDown({ text: 'abc\nd', cursor: 2 }).cursor).toBe(5)
  })

  it('已在首行时上移到缓冲开头', () => {
    expect(moveUp({ text: 'ab\ncd', cursor: 1 }).cursor).toBe(0)
  })

  it('已在末行时下移到缓冲结尾', () => {
    expect(moveDown({ text: 'ab\ncd', cursor: 4 }).cursor).toBe(5)
  })
})

describe('moveHome / moveEnd', () => {
  it('Home 移到当前行起点', () => {
    expect(moveHome({ text: 'ab\ncd', cursor: 4 }).cursor).toBe(3)
  })

  it('End 移到当前行终点', () => {
    expect(moveEnd({ text: 'ab\ncd', cursor: 3 }).cursor).toBe(5)
  })

  it('Home 对首行有效', () => {
    expect(moveHome({ text: 'ab\ncd', cursor: 1 }).cursor).toBe(0)
  })
})

describe('moveBufferStart / moveBufferEnd', () => {
  it('PageUp 移到整个缓冲开头', () => {
    expect(moveBufferStart({ text: 'ab\ncd', cursor: 4 }).cursor).toBe(0)
  })

  it('PageDown 移到整个缓冲结尾', () => {
    expect(moveBufferEnd({ text: 'ab\ncd', cursor: 1 }).cursor).toBe(5)
  })
})

describe('reduce', () => {
  it('insert 事件等价于插入文本', () => {
    expect(reduce(emptyBuffer, { type: 'insert', text: 'x' })).toEqual({ text: 'x', cursor: 1 })
  })

  it('newline 事件插入换行符', () => {
    expect(reduce({ text: 'ab', cursor: 2 }, { type: 'newline' })).toEqual({ text: 'ab\n', cursor: 3 })
  })

  it('backspace 事件删除前一字符', () => {
    expect(reduce({ text: 'ab', cursor: 2 }, { type: 'backspace' })).toEqual({ text: 'a', cursor: 1 })
  })

  it('delete 事件删除后一字符', () => {
    expect(reduce({ text: 'ab', cursor: 0 }, { type: 'delete' })).toEqual({ text: 'b', cursor: 0 })
  })

  it('方向事件移动光标', () => {
    expect(reduce({ text: 'ab', cursor: 2 }, { type: 'left' }).cursor).toBe(1)
  })

  it('pageUp/pageDown 事件移到缓冲首/尾', () => {
    expect(reduce({ text: 'ab\ncd', cursor: 3 }, { type: 'pageUp' }).cursor).toBe(0)
    expect(reduce({ text: 'ab\ncd', cursor: 1 }, { type: 'pageDown' }).cursor).toBe(5)
  })

  it('submit / none 不改动缓冲', () => {
    const buf = { text: 'ab', cursor: 1 }
    expect(reduce(buf, { type: 'submit' })).toBe(buf)
    expect(reduce(buf, { type: 'none' })).toBe(buf)
  })
})

describe('splitForRender', () => {
  it('在光标所在行切出 before/光标字符/after', () => {
    // 'ab\ncd' 光标 1（第一行 b 前）
    const out = splitForRender({ text: 'ab\ncd', cursor: 1 })
    expect(out).toEqual([
      { before: 'a', cursor: 'b', after: '', hasCursor: true },
      { before: 'cd', cursor: '', after: '', hasCursor: false },
    ])
  })

  it('光标在行尾时用空格作光标块', () => {
    const out = splitForRender({ text: 'ab', cursor: 2 })
    expect(out).toEqual([{ before: 'ab', cursor: ' ', after: '', hasCursor: true }])
  })

  it('光标在下一行行首', () => {
    const out = splitForRender({ text: 'a\nb', cursor: 2 })
    expect(out).toEqual([
      { before: 'a', cursor: '', after: '', hasCursor: false },
      { before: '', cursor: 'b', after: '', hasCursor: true },
    ])
  })

  it('空缓冲渲染为单行、光标为空格块', () => {
    expect(splitForRender(emptyBuffer)).toEqual([{ before: '', cursor: ' ', after: '', hasCursor: true }])
  })
})
