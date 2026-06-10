import { describe, it, expect } from 'vitest'
import {
  enterInputMode,
  leaveInputMode,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from './protocol.js'
import {
  ENABLE_KITTY_KEYBOARD,
  DISABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  DISABLE_MODIFY_OTHER_KEYS,
} from './termio/csi.js'

describe('enterInputMode', () => {
  it('开 bracketed paste、推 kitty、开 modifyOtherKeys', () => {
    const out: string[] = []
    enterInputMode((s) => out.push(s))
    expect(out).toEqual([
      ENABLE_BRACKETED_PASTE,
      ENABLE_KITTY_KEYBOARD,
      ENABLE_MODIFY_OTHER_KEYS,
    ])
  })
})

describe('leaveInputMode', () => {
  it('逆序还原:关 modifyOtherKeys、弹 kitty、关 bracketed paste', () => {
    const out: string[] = []
    leaveInputMode((s) => out.push(s))
    expect(out).toEqual([
      DISABLE_MODIFY_OTHER_KEYS,
      DISABLE_KITTY_KEYBOARD,
      DISABLE_BRACKETED_PASTE,
    ])
  })
})

describe('bracketed paste 常量', () => {
  it('值正确', () => {
    expect(ENABLE_BRACKETED_PASTE).toBe('\x1b[?2004h')
    expect(DISABLE_BRACKETED_PASTE).toBe('\x1b[?2004l')
  })
})
