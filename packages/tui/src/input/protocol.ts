/**
 * 终端输入协议的进出开关。
 * 进入时开启 bracketed paste + Kitty keyboard + modifyOtherKeys;
 * 退出时逆序还原,避免把用户终端留在坏状态(见 spec §9)。
 * 对不支持这些协议的终端,推送会被静默忽略,不报错;Shift+Enter 自动回落兜底。
 */

import {
  ENABLE_KITTY_KEYBOARD,
  DISABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  DISABLE_MODIFY_OTHER_KEYS,
} from './termio/csi.js'

/** 开启 bracketed paste(DEC private mode 2004)。 */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
/** 关闭 bracketed paste。 */
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'

/** 进入输入模式:写出开启序列。 */
export function enterInputMode(write: (s: string) => void): void {
  write(ENABLE_BRACKETED_PASTE)
  write(ENABLE_KITTY_KEYBOARD)
  write(ENABLE_MODIFY_OTHER_KEYS)
}

/** 退出输入模式:逆序写出还原序列。 */
export function leaveInputMode(write: (s: string) => void): void {
  write(DISABLE_MODIFY_OTHER_KEYS)
  write(DISABLE_KITTY_KEYBOARD)
  write(DISABLE_BRACKETED_PASTE)
}
