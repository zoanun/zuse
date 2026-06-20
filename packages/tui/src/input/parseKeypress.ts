/**
 * 键盘输入解析器 —— 把终端输入转成按键事件。
 *
 * 用 termio tokenizer 做转义序列边界检测,再把序列解释为 ParsedKey。
 * 自 cc-haha 裁剪移植:去掉了鼠标(SGR/X10)与终端响应回包(DA1/DA2/DECRPM/
 * OSC/XTVERSION/kitty-flags/cursor)分支,本期不处理这些。
 */
import { Buffer } from 'buffer'
import { PASTE_END, PASTE_START } from './termio/csi.js'
import { createTokenizer, type Tokenizer } from './termio/tokenize.js'

const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/

const FN_KEY_RE =
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

// CSI u(kitty keyboard 协议):ESC [ 码位 [; 修饰] u
// 例:ESC[13;2u = Shift+Enter,ESC[27u = Escape(无修饰)。
// 修饰缺省为 1(无修饰)。
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/

// xterm modifyOtherKeys:ESC [ 27 ; 修饰 ; 码位 ~
// 例:ESC[27;2;13~ = Shift+Enter。Ghostty/tmux/xterm/VSCode 在 modifyOtherKeys=2
// 时发这种。注意参数顺序与 CSI u 相反(先修饰、后码位)。
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/

function createPasteKey(content: string): ParsedKey {
  // 粘贴内容里的换行可能是 CR 或 CRLF(多数终端在 bracketed paste 里把换行发成
  // \r 或 \r\n),统一规范成 \n。否则裸 \r 进入文本缓冲后,splitForRender 只按
  // \n 切行、整段当一行,渲染时 CR 让终端回车覆盖打印,导致多行粘贴显示错乱。
  const normalized = content.replace(/\r\n?/g, '\n')
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: normalized,
    raw: normalized,
    isPasted: true,
  }
}

export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  // 内部 tokenizer 实例(跨 chunk 复用)
  _tokenizer?: Tokenizer
}

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      // 单字节高位置位 = meta 编码:减 128 还原并补 ESC 前缀。用 fromCharCode 计算,
      // 不就地改写传入的 Buffer(可能来自 Node buffer pool,变异会污染调用方同一引用)。
      return '\x1b' + String.fromCharCode(input[0]! - 128)
    } else {
      return String(input)
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input)
  } else if (!input) {
    return ''
  } else {
    return input
  }
}

/**
 * 喂入一个 chunk(或 null 表示 flush),返回解析出的按键序列与新状态。
 * 粘贴聚合在此完成:PASTE_START..PASTE_END 之间的所有 token(含跨 chunk)
 * 累积为一个 isPasted=true 的 ParsedKey;空粘贴也产出(供将来图片侦测)。
 */
export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedKey[], KeyParseState] {
  const isFlush = input === null
  const inputString = isFlush ? '' : inputToString(input)

  // 取或建 tokenizer
  const tokenizer = prevState._tokenizer ?? createTokenizer()

  // 切 token
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString)

  const keys: ParsedKey[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true
        pasteBuffer = ''
      } else if (token.value === PASTE_END) {
        // 始终产出一个 paste key,空粘贴也产出——让下游能侦测空粘贴
        // (将来用于剪贴板图片处理)。
        keys.push(createPasteKey(pasteBuffer))
        inPaste = false
        pasteBuffer = ''
      } else if (inPaste) {
        // 粘贴态里的序列当字面文本累积
        pasteBuffer += token.value
      } else {
        keys.push(parseKeypress(token.value))
      }
    } else {
      // text token
      if (inPaste) {
        pasteBuffer += token.value
      } else {
        keys.push(parseKeypress(token.value))
      }
    }
  }

  // flush 时若仍在粘贴态且有内容,吐出残留
  if (isFlush && inPaste && pasteBuffer) {
    keys.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  const newState: KeyParseState = {
    mode: inPaste ? 'IN_PASTE' : 'NORMAL',
    incomplete: tokenizer.buffer(),
    pasteBuffer,
    _tokenizer: tokenizer,
  }

  return [keys, newState]
}

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O letter */
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  /* 小键盘应用模式(数字 0-9) */
  Op: '0',
  Oq: '1',
  Or: '2',
  Os: '3',
  Ot: '4',
  Ou: '5',
  Ov: '6',
  Ow: '7',
  Ox: '8',
  Oy: '9',
  /* 小键盘应用模式(运算符) */
  Oj: '*',
  Ok: '+',
  Ol: ',',
  Om: '-',
  On: '.',
  Oo: '/',
  OM: 'return',
  /* xterm/rxvt ESC [ number ~ */
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  /* Cygwin / libuv */
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  /* common */
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  /* xterm ESC [ letter */
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  /* xterm/gnome ESC O letter */
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  /* xterm/rxvt ESC [ number ~ */
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  /* putty */
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  /* rxvt */
  '[7~': 'home',
  '[8~': 'end',
  /* rxvt 带修饰 */
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',

  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',

  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',

  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  /* misc. */
  '[Z': 'tab',
}

const isShiftKey = (code: string): boolean => {
  return [
    '[a',
    '[b',
    '[c',
    '[d',
    '[e',
    '[2$',
    '[3$',
    '[5$',
    '[6$',
    '[7$',
    '[8$',
    '[Z',
  ].includes(code)
}

const isCtrlKey = (code: string): boolean => {
  return [
    'Oa',
    'Ob',
    'Oc',
    'Od',
    'Oe',
    '[2^',
    '[3^',
    '[5^',
    '[6^',
    '[7^',
    '[8^',
  ].includes(code)
}

/**
 * 解码 XTerm 风格修饰值为各标志。
 * 编码:1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0) + (super?8:0)
 * 注:这里 meta 指 Alt/Option(bit 2);super 是独立修饰(bit 8,macOS Cmd / Win 键)。
 */
function decodeModifier(modifier: number): {
  shift: boolean
  meta: boolean
  ctrl: boolean
  super: boolean
} {
  const m = modifier - 1
  return {
    shift: !!(m & 1),
    meta: !!(m & 2),
    ctrl: !!(m & 4),
    super: !!(m & 8),
  }
}

/**
 * 把 modifyOtherKeys / CSI u 的码位映射为键名。
 * 兼顾 ASCII 码位与 Kitty 协议功能键(小键盘码位取自 Unicode 私有区)。
 */
function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return 'tab'
    case 13:
      return 'return'
    case 27:
      return 'escape'
    case 32:
      return 'space'
    case 127:
      return 'backspace'
    // Kitty 小键盘 KP_0..KP_9
    case 57399:
      return '0'
    case 57400:
      return '1'
    case 57401:
      return '2'
    case 57402:
      return '3'
    case 57403:
      return '4'
    case 57404:
      return '5'
    case 57405:
      return '6'
    case 57406:
      return '7'
    case 57407:
      return '8'
    case 57408:
      return '9'
    case 57409: // KP_DECIMAL
      return '.'
    case 57410: // KP_DIVIDE
      return '/'
    case 57411: // KP_MULTIPLY
      return '*'
    case 57412: // KP_SUBTRACT
      return '-'
    case 57413: // KP_ADD
      return '+'
    case 57414: // KP_ENTER
      return 'return'
    case 57415: // KP_EQUAL
      return '='
    default:
      // 可打印 ASCII
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase()
      }
      return undefined
  }
}

export type ParsedKey = {
  kind: 'key'
  fn: boolean
  name: string | undefined
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence: string | undefined
  raw: string | undefined
  code?: string
  isPasted: boolean
}

function parseKeypress(s: string = ''): ParsedKey {
  let parts

  const key: ParsedKey = {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }

  key.sequence = key.sequence || s || key.name

  // CSI u(kitty keyboard):ESC [ 码位 [; 修饰] u
  let match: RegExpExecArray | null
  if ((match = CSI_U_RE.exec(s))) {
    const codepoint = parseInt(match[1]!, 10)
    const modifier = match[2] ? parseInt(match[2], 10) : 1
    const mods = decodeModifier(modifier)
    const name = keycodeToName(codepoint)
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  // xterm modifyOtherKeys:ESC [ 27 ; 修饰 ; 码位 ~
  // 必须在 FN_KEY_RE 之前——FN_KEY_RE 只允许 ~ 前两个参数,会把尾巴留成垃圾。
  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    const mods = decodeModifier(parseInt(match[1]!, 10))
    const name = keycodeToName(parseInt(match[2]!, 10))
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  if (s === '\r') {
    key.raw = undefined
    key.name = 'return'
  } else if (s === '\n') {
    key.name = 'enter'
  } else if (s === '\t') {
    key.name = 'tab'
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape'
    key.meta = s.length === 2
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space'
    key.meta = s.length === 2
  } else if (s === '\x1f') {
    key.name = '_'
    key.ctrl = true
  } else if (s <= '\x1a' && s.length === 1) {
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
    key.ctrl = true
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number'
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase()
    key.shift = true
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.meta = true
    key.shift = /^[A-Z]$/.test(parts[1]!)
  } else if ((parts = FN_KEY_RE.exec(s))) {
    const segs = [...s]

    if (segs[0] === '\x1b' && segs[1] === '\x1b') {
      key.option = true
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter(Boolean)
      .join('')

    const modifier = ((parts[3] || parts[5] || 1) as number) - 1

    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.shift = !!(modifier & 1)
    key.code = code

    key.name = keyName[code]
    key.shift = isShiftKey(code) || key.shift
    key.ctrl = isCtrlKey(code) || key.ctrl
  }

  // iTerm 自然文本编辑模式
  if (key.raw === '\x1Bb') {
    key.meta = true
    key.name = 'left'
  } else if (key.raw === '\x1Bf') {
    key.meta = true
    key.name = 'right'
  }

  switch (s) {
    case '\x1b[1~':
      return createNavKey(s, 'home', false)
    case '\x1b[4~':
      return createNavKey(s, 'end', false)
    case '\x1b[5~':
      return createNavKey(s, 'pageup', false)
    case '\x1b[6~':
      return createNavKey(s, 'pagedown', false)
    case '\x1b[1;5D':
      return createNavKey(s, 'left', true)
    case '\x1b[1;5C':
      return createNavKey(s, 'right', true)
  }

  return key
}

function createNavKey(s: string, name: string, ctrl: boolean): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}

export { parseKeypress }
