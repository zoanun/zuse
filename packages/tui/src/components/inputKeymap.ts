import type { InputEvent } from './textBuffer.js'

/**
 * Ink `useInput` 回调里 key 标志的子集（全部可选，便于测试只传需要的字段；
 * Ink 的 Key 各字段为必填 boolean，结构上可赋给此类型）。
 * Ink 把 Alt 上报为 `meta`。
 */
export interface KeyState {
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  ctrl?: boolean
  meta?: boolean
}

/**
 * 把一次 Ink 按键 (input, key) 映射为编辑事件。纯函数，便于单测。
 * 绑定：Enter 提交、Alt+Enter 换行、方向键移动、Ctrl+A/E 行首尾、退格删除；
 * 其余未绑定的控制键一律 none（不插入），Escape 也返回 none 交由上层处理。
 */
export function keyToEvent(input: string, key: KeyState): InputEvent {
  // 回车：带 meta（Alt）插入换行，否则提交。
  if (key.return) return key.meta ? { type: 'newline' } : { type: 'submit' }

  // 退格：终端常把退格上报为 delete，两者都按删除前一字符处理。
  if (key.backspace || key.delete) return { type: 'backspace' }

  if (key.leftArrow) return { type: 'left' }
  if (key.rightArrow) return { type: 'right' }
  if (key.upArrow) return { type: 'up' }
  if (key.downArrow) return { type: 'down' }

  // readline 风格行首/行尾。
  if (key.ctrl && input === 'a') return { type: 'home' }
  if (key.ctrl && input === 'e') return { type: 'end' }

  if (key.escape) return { type: 'none' }

  // 可打印字符（含粘贴的多字符）才插入；带 ctrl/meta 的组合不插入。
  if (input && !key.ctrl && !key.meta) return { type: 'insert', text: input }

  return { type: 'none' }
}
