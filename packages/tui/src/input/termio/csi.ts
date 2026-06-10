/**
 * CSI(Control Sequence Introducer)字节判定与序列生成。
 * 自 cc-haha 裁剪移植:只保留 tokenizer/parseKeypress 与协议推送需要的部分,
 * 去掉了 CSI 名表、光标/擦除/滚动生成器、焦点事件标记。
 */

import { ESC, ESC_TYPE, SEP } from './ansi.js'

export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI)

/** CSI 各字节区间。 */
export const CSI_RANGE = {
  PARAM_START: 0x30,
  PARAM_END: 0x3f,
  INTERMEDIATE_START: 0x20,
  INTERMEDIATE_END: 0x2f,
  FINAL_START: 0x40,
  FINAL_END: 0x7e,
} as const

/** 是否 CSI 参数字节。 */
export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END
}

/** 是否 CSI 中间字节。 */
export function isCSIIntermediate(byte: number): boolean {
  return (
    byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END
  )
}

/** 是否 CSI 终止字节(@ 到 ~)。 */
export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END
}

/**
 * 生成 CSI 序列:ESC [ p1;p2;...;pN final。
 * 单参:当作裸 body;多参:末位为终止字节,其余为参数(以 ; 连接)。
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const params = args.slice(0, -1)
  const final = args[args.length - 1]
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

// Bracketed paste 标记(终端发来的输入,非输出)。开启 DEC mode 2004 后,
// 终端用这两个标记包裹粘贴内容。
export const PASTE_START = csi('200~')
export const PASTE_END = csi('201~')

// Kitty keyboard 协议(CSI u):推送 flags=1(消歧转义码),使 Shift+Enter
// 改发 CSI 13;2 u 而非裸 CR。退出时用 CSI < u 弹栈还原。
export const ENABLE_KITTY_KEYBOARD = csi('>1u')
export const DISABLE_KITTY_KEYBOARD = csi('<u')

// xterm modifyOtherKeys level 2:tmux/xterm/VSCode(xterm.js)走这条通道
// 上报扩展键,Shift+Enter 编为 CSI 27;2;13 ~。退出时复位。
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
