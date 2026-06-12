import { describe, it, expect } from 'vitest'
import { padToWidth } from './userEcho.js'

describe('padToWidth 用户消息行补齐', () => {
  it('ASCII 行补空格到终端宽度(底色铺满整行)', () => {
    // '› hello' 可见宽度 7,补到 20 列需 13 个空格。
    expect(padToWidth('› hello', 20)).toBe(' '.repeat(13))
  })

  it('中文按双宽字符计宽,不能用 .length', () => {
    // '› 你好' = 2(› + 空格) + 4(两个全角) = 6,补到 10 列需 4 个空格。
    expect(padToWidth('› 你好', 10)).toBe(' '.repeat(4))
  })

  it('行宽恰好等于终端宽度时不再补(避免多 1 格触发折行)', () => {
    expect(padToWidth('12345', 5)).toBe('')
  })

  it('行宽超出终端宽度(Ink 自行折行)时不补', () => {
    expect(padToWidth('123456789', 5)).toBe('')
  })
})
