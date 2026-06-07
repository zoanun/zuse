import type { InputEvent } from './textBuffer.js'

/**
 * Ink `useInput` 回调里 key 标志的子集（全部可选，便于测试只传需要的字段；
 * Ink 的 Key 各字段为必填 boolean，结构上可赋给此类型）。
 * Ink 把 Ctrl 上报为 `ctrl`、Alt 上报为 `meta`。
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
 * 绑定：Enter 提交、Ctrl+Enter / Ctrl+J 换行、方向键移动、Ctrl+A/E 行首尾、退格删除；
 * 其余未绑定的控制键一律 none（不插入），Escape 也返回 none 交由上层处理。
 *
 * 换行键 Ctrl+Enter：普通终端按它直接发裸 LF（0x0a，见下方 LF 分支）；VSCode 系集成终端
 * 默认吃掉 Ctrl+Enter,故需 /terminal-setup 在 keybindings.json 里把它配为「发送 ESC+CR(`\r`)」。stock Ink
 * 解析该序列时剥掉 ESC 前缀只剩 `\r`，但不置 return 标志（区别于普通回车 key.return=true），
 * 故这里用「input==='\r' 且无 return」识别为换行。普通 Enter（key.return=true，含被忽略的
 * Ctrl/Alt 修饰）一律提交。配置见 docs / 启动横幅提示。
 */
export function keyToEvent(input: string, key: KeyState): InputEvent {
  // 普通回车（key.return）：提交。Ctrl/Alt 等修饰在回车上一律忽略。
  if (key.return) return { type: 'submit' }
  // Ctrl+Enter（VSCode 集成终端）：经 keybindings 发来的 ESC+CR 被 Ink 剥成裸`\r` 且无 return 标志 → 换行。
  if (input === '\r') return { type: 'newline' }
  // 裸 LF（0x0a）：Ctrl+J、以及普通终端按 Ctrl+Enter 都发它。任何终端都能原生发出且与 Enter(CR) 可区分 ——
  // 普通 PowerShell/Windows Terminal 等无法把 Shift+Enter 编码成独立按键（与 Enter 同字节）,
  // 而 VSCode 的 sendSequence 配置只在其集成终端生效;Ctrl+J 则处处可用。Ink 把 `\n` 解析为
  // name='enter'(非 'return'),故 key.return=false、ctrl=false,落到这里。
  if (input === '\n') return { type: 'newline' }

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
