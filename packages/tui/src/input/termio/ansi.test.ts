import { describe, it, expect } from 'vitest'
import { C0, ESC, BEL, SEP, ESC_TYPE, isC0, isEscFinal } from './ansi.js'

describe('ansi 常量', () => {
  it('C0 控制字符码位正确', () => {
    expect(C0.ESC).toBe(0x1b)
    expect(C0.LF).toBe(0x0a)
    expect(C0.CR).toBe(0x0d)
    expect(C0.DEL).toBe(0x7f)
  })

  it('字符串常量正确', () => {
    expect(ESC).toBe('\x1b')
    expect(BEL).toBe('\x07')
    expect(SEP).toBe(';')
  })

  it('ESC_TYPE 各成员码位正确', () => {
    expect(ESC_TYPE.CSI).toBe(0x5b)
    expect(ESC_TYPE.OSC).toBe(0x5d)
    expect(ESC_TYPE.DCS).toBe(0x50)
    expect(ESC_TYPE.APC).toBe(0x5f)
    expect(ESC_TYPE.PM).toBe(0x5e)
    expect(ESC_TYPE.SOS).toBe(0x58)
    expect(ESC_TYPE.ST).toBe(0x5c)
  })
})

describe('isC0', () => {
  it('控制区与 DEL 判真,可打印判假', () => {
    expect(isC0(0x00)).toBe(true)
    expect(isC0(0x1f)).toBe(true)
    expect(isC0(0x7f)).toBe(true)
    expect(isC0(0x20)).toBe(false) // 空格,第一个可打印字符
    expect(isC0(0x41)).toBe(false) // 'A'
  })
})

describe('isEscFinal', () => {
  it('0x30..0x7e 为终止字节', () => {
    expect(isEscFinal(0x30)).toBe(true)
    expect(isEscFinal(0x7e)).toBe(true)
    expect(isEscFinal(0x2f)).toBe(false)
    expect(isEscFinal(0x7f)).toBe(false)
  })
})
