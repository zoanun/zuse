import { describe, it, expect } from 'vitest'
import {
  csi,
  isCSIParam,
  isCSIIntermediate,
  isCSIFinal,
  PASTE_START,
  PASTE_END,
  ENABLE_KITTY_KEYBOARD,
  DISABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  DISABLE_MODIFY_OTHER_KEYS,
} from './csi.js'

describe('csi()', () => {
  it('单参为裸 body', () => {
    expect(csi('200~')).toBe('\x1b[200~')
  })
  it('多参:末位为终止字节,其余以 ; 连接', () => {
    expect(csi(13, 2, 'u')).toBe('\x1b[13;2u')
  })
})

describe('CSI 字节判定', () => {
  it('参数字节 0x30..0x3f', () => {
    expect(isCSIParam(0x2f)).toBe(false)
    expect(isCSIParam(0x30)).toBe(true)
    expect(isCSIParam(0x3f)).toBe(true)
    expect(isCSIParam(0x40)).toBe(false)
  })
  it('中间字节 0x20..0x2f', () => {
    expect(isCSIIntermediate(0x1f)).toBe(false)
    expect(isCSIIntermediate(0x20)).toBe(true)
    expect(isCSIIntermediate(0x2f)).toBe(true)
    expect(isCSIIntermediate(0x30)).toBe(false)
  })
  it('终止字节 0x40..0x7e', () => {
    expect(isCSIFinal(0x40)).toBe(true)
    expect(isCSIFinal(0x7e)).toBe(true)
    expect(isCSIFinal(0x3f)).toBe(false)
    expect(isCSIFinal(0x7f)).toBe(false)
  })
})

describe('粘贴标记与协议开关常量', () => {
  it('bracketed paste 标记', () => {
    expect(PASTE_START).toBe('\x1b[200~')
    expect(PASTE_END).toBe('\x1b[201~')
  })
  it('kitty keyboard 推/弹', () => {
    expect(ENABLE_KITTY_KEYBOARD).toBe('\x1b[>1u')
    expect(DISABLE_KITTY_KEYBOARD).toBe('\x1b[<u')
  })
  it('modifyOtherKeys 开/关', () => {
    expect(ENABLE_MODIFY_OTHER_KEYS).toBe('\x1b[>4;2m')
    expect(DISABLE_MODIFY_OTHER_KEYS).toBe('\x1b[>4m')
  })
})
