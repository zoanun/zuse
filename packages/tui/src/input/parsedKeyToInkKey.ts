import type { ParsedKey } from './parseKeypress.js'

/**
 * Ink 风格的按键标志形状,只含本项目 4 个调用点实际用到的字段
 * (App / InputBox / ModelSelect / SelectList),外加 keyToEvent 的 shift。
 * 结构上可赋给 inputKeymap 的 KeyState(各字段为必填 boolean)。
 */
export interface InkKey {
  return: boolean
  escape: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  leftArrow: boolean
  rightArrow: boolean
  upArrow: boolean
  downArrow: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface MappedKey {
  input: string
  key: InkKey
}

function blankKey(): InkKey {
  return {
    return: false,
    escape: false,
    tab: false,
    backspace: false,
    delete: false,
    leftArrow: false,
    rightArrow: false,
    upArrow: false,
    downArrow: false,
    ctrl: false,
    meta: false,
    shift: false,
  }
}

/**
 * 把内部 ParsedKey 映射为 (input, InkKey)。
 * 设计目标:映射结果喂给现有 keyToEvent / 各组件的 key.xxx 判断时,行为与
 * 迁移前用 Ink useInput 完全一致(故 4 个调用点零改动,仅换 import)。
 */
export function parsedKeyToInkKey(parsed: ParsedKey): MappedKey {
  const key = blankKey()
  key.ctrl = parsed.ctrl
  key.meta = parsed.meta
  key.shift = parsed.shift

  switch (parsed.name) {
    case 'return':
      key.return = true
      return { input: '', key }
    case 'enter':
      // 裸 LF:Ctrl+J / 普通终端 Ctrl+Enter。交给 keyToEvent 的 input==='\n' 分支换行。
      return { input: '\n', key }
    case 'escape':
      key.escape = true
      return { input: '', key }
    case 'tab':
      key.tab = true
      return { input: '', key }
    case 'backspace':
      key.backspace = true
      return { input: '', key }
    case 'delete':
      key.delete = true
      return { input: '', key }
    case 'up':
      key.upArrow = true
      return { input: '', key }
    case 'down':
      key.downArrow = true
      return { input: '', key }
    case 'left':
      key.leftArrow = true
      return { input: '', key }
    case 'right':
      key.rightArrow = true
      return { input: '', key }
    case 'space':
      return { input: ' ', key }
  }

  // VSCode 集成终端经 /terminal-setup 发来的 ESC+CR:旧兜底,仍判为换行。
  if (parsed.sequence === '\x1b\r') {
    return { input: '\n', key }
  }

  // 控制组合(Ctrl+字母):input 用规范化键名(如 'a'/'c'),保留 ctrl 标志供上层识别。
  if (parsed.ctrl && parsed.name) {
    return { input: parsed.name, key }
  }

  // 其余:可打印字符、大写字母、粘贴文本——用原始序列作为插入文本。
  return { input: parsed.sequence ?? '', key }
}
