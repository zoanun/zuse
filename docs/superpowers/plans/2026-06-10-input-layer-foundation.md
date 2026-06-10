# 输入层地基(第一期)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/tui` 内自建输入子系统,独占 `process.stdin`,让 Ink 退化为纯渲染器,从而获得稳定的按键/序列解析、可靠的 `isPasted`,并根治 Shift+Enter。

**Architecture:** 入口给 Ink 喂一个非 TTY 哑流(`render(<App/>, { stdin: dummyStdin })`),Ink 永不碰键盘。自建子系统接管真实 stdin(自管 raw mode)→ 移植自 cc-haha 的 termio tokenizer 跨 chunk 切分 token → 裁剪版 parseKeypress 解析为 `ParsedKey`(含 `isPasted`、CSI-u/modifyOtherKeys 解出的 shift)→ 映射成 Ink 风格 `InkKey` → 经 `InputBus` 广播给 `useInput` 订阅者。进入时推送 bracketed paste + Kitty keyboard + modifyOtherKeys 协议,退出时还原。

**Tech Stack:** TypeScript(ESM,`.js` 扩展名导入)、React 18、Ink 5、vitest 2(根 `vitest.config.ts`,`include: packages/*/src/**/*.test.ts`)、pnpm workspace(`@zuse/tui`)。

---

## 约定与背景(执行前必读)

- **权威 spec:** [docs/superpowers/specs/2026-06-10-input-layer-paste-collapse-design.md](../specs/2026-06-10-input-layer-paste-collapse-design.md)。本计划实现其 §8「第一期」。第二期(粘贴折叠 UI)与附件均**不在本计划范围**。
- **参考实现:** `e:/ai-study/cc-haha/src/ink/`。本计划的 `termio/*` 与 `parseKeypress.ts` 是对它的**裁剪移植**——去掉鼠标(SGR/X10)、终端响应回包(DA1/DA2/DECRPM/OSC/XTVERSION/kitty-flags/cursor)分支。计划里已给出裁剪后的**完整文件内容**,照抄即可,无需回看源码。
- **代码注释一律用中文**(项目记忆)。
- **提交时机:** 本项目约定**评审前不提交、不推送**(全局记忆「no-commit-before-review」)。因此本计划用「检查点」(跑测试 + typecheck)代替逐任务 `git commit`;全部完成、用户评审通过后再由用户决定提交。
- **跨平台:** Windows / macOS / Linux 都要可用。Windows 下注意在挂监听器前 `setEncoding('utf8')`。
- **命令工作目录:** 所有 `npx`/`pnpm` 命令在仓库根 `e:\ai-study\zuse` 下执行。
- **运行单个测试文件:** `npx vitest run <相对路径>`;按用例名:`npx vitest run <路径> -t "<用例名>"`。

### 目标文件结构(本期新增/修改)

```
packages/tui/src/input/
  termio/ansi.ts            原样移植(C0/ESC_TYPE/isC0/isEscFinal/ESC/BEL/SEP)
  termio/ansi.test.ts
  termio/csi.ts             裁剪移植(isCSI*、csi()、PASTE_START/END、协议开关常量)
  termio/csi.test.ts
  termio/tokenize.ts        裁剪移植(去 x10Mouse 分支)
  termio/tokenize.test.ts
  parseKeypress.ts          裁剪移植(去鼠标/终端响应分支)
  parseKeypress.test.ts
  parsedKeyToInkKey.ts       新写:ParsedKey → InkKey + input
  parsedKeyToInkKey.test.ts
  inputBus.ts                新写:订阅/广播,isActive 门控
  inputBus.test.ts
  protocol.ts                新写:进出时开关 bracketed paste / kitty / modifyOtherKeys
  protocol.test.ts
  stdin.ts                   新写:接管 process.stdin、raw mode 生命周期、喂 tokenizer
  stdin.test.ts
  InputProvider.tsx          新写:React Context,挂载时启停 stdin manager
  useInput.ts                新写:与 Ink useInput 同签名的 shim

packages/tui/src/index.tsx               修改:Ink 喂哑 stdin + 外层包 InputProvider
packages/tui/src/App.tsx                 修改:useInput 改从 input shim 导入
packages/tui/src/components/InputBox.tsx        修改:useInput 改导入
packages/tui/src/components/ModelSelect.tsx     修改:useInput 改导入
packages/tui/src/components/SelectList.tsx      修改:useInput 改导入
packages/tui/src/components/inputKeymap.ts      修改:KeyState 加 shift,keyToEvent 加 Shift+Enter→换行
```

---

## Task 1: 移植 termio/ansi.ts(ANSI 常量与判定)

**Files:**
- Create: `packages/tui/src/input/termio/ansi.ts`
- Test: `packages/tui/src/input/termio/ansi.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/termio/ansi.test.ts`:

```ts
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

  it('ESC_TYPE.CSI 为 [ 的码位', () => {
    expect(ESC_TYPE.CSI).toBe(0x5b)
  })
})

describe('isC0', () => {
  it('控制区与 DEL 判真,可打印判假', () => {
    expect(isC0(0x00)).toBe(true)
    expect(isC0(0x1f)).toBe(true)
    expect(isC0(0x7f)).toBe(true)
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/termio/ansi.test.ts`
Expected: FAIL,报找不到模块 `./ansi.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/termio/ansi.ts`:

```ts
/**
 * ANSI 控制字符与转义序列引导字节(依据 ECMA-48 / ANSI X3.64)。
 * 自 cc-haha 原样移植,体量小、无裁剪。
 */

/** C0(7 位)控制字符码位表。 */
export const C0 = {
  NUL: 0x00,
  SOH: 0x01,
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  BEL: 0x07,
  BS: 0x08,
  HT: 0x09,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  SO: 0x0e,
  SI: 0x0f,
  DLE: 0x10,
  DC1: 0x11,
  DC2: 0x12,
  DC3: 0x13,
  DC4: 0x14,
  NAK: 0x15,
  SYN: 0x16,
  ETB: 0x17,
  CAN: 0x18,
  EM: 0x19,
  SUB: 0x1a,
  ESC: 0x1b,
  FS: 0x1c,
  GS: 0x1d,
  RS: 0x1e,
  US: 0x1f,
  DEL: 0x7f,
} as const

// 用于生成输出的字符串常量
export const ESC = '\x1b'
export const BEL = '\x07'
export const SEP = ';'

/** 转义序列类型引导字节(ESC 之后那一字节)。 */
export const ESC_TYPE = {
  CSI: 0x5b, // [ - Control Sequence Introducer
  OSC: 0x5d, // ] - Operating System Command
  DCS: 0x50, // P - Device Control String
  APC: 0x5f, // _ - Application Program Command
  PM: 0x5e, // ^ - Privacy Message
  SOS: 0x58, // X - Start of String
  ST: 0x5c, // \ - String Terminator
} as const

/** 是否 C0 控制字符。 */
export function isC0(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f
}

/**
 * 是否 ESC 序列的终止字节(0-9、:、;、<、=、>、?、@ 到 ~)。
 * ESC 序列的终止字节范围比 CSI 更宽。
 */
export function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/termio/ansi.test.ts`
Expected: PASS(3 个 describe,全部用例绿)。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/termio/ansi.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 测试通过且无类型错误。

---

## Task 2: 移植裁剪 termio/csi.ts(CSI 判定 + 协议开关常量)

**Files:**
- Create: `packages/tui/src/input/termio/csi.ts`
- Test: `packages/tui/src/input/termio/csi.test.ts`

> 裁剪要点:去掉 cc-haha 原 csi.ts 里的 CSI 名表、光标/擦除/滚动生成器、FOCUS_IN/OUT。只留 tokenizer 需要的 `isCSI*`、`csi()`,以及粘贴标记和协议开关常量。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/termio/csi.test.ts`:

```ts
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
    expect(isCSIParam(0x30)).toBe(true)
    expect(isCSIParam(0x3f)).toBe(true)
    expect(isCSIParam(0x40)).toBe(false)
  })
  it('中间字节 0x20..0x2f', () => {
    expect(isCSIIntermediate(0x20)).toBe(true)
    expect(isCSIIntermediate(0x2f)).toBe(true)
    expect(isCSIIntermediate(0x30)).toBe(false)
  })
  it('终止字节 0x40..0x7e', () => {
    expect(isCSIFinal(0x40)).toBe(true)
    expect(isCSIFinal(0x7e)).toBe(true)
    expect(isCSIFinal(0x3f)).toBe(false)
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/termio/csi.test.ts`
Expected: FAIL,找不到 `./csi.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/termio/csi.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/termio/csi.test.ts`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/termio/csi.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 3: 移植裁剪 termio/tokenize.ts(跨 chunk 序列切分)

**Files:**
- Create: `packages/tui/src/input/termio/tokenize.ts`
- Test: `packages/tui/src/input/termio/tokenize.test.ts`

> 裁剪要点:去掉 `x10Mouse` 选项及 `csi` 状态里的 X10 鼠标分支。`createTokenizer()` 不再接受参数。其余状态机逻辑原样保留。
> **关键认知:** tokenizer **不聚合粘贴**——它把 `PASTE_START`/`PASTE_END` 当普通 sequence token 吐出。粘贴聚合在 Task 4 的 `parseMultipleKeypresses` 里完成。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/termio/tokenize.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTokenizer } from './tokenize.js'

describe('createTokenizer.feed', () => {
  it('纯文本原样成一个 text token', () => {
    const t = createTokenizer()
    expect(t.feed('hello')).toEqual([{ type: 'text', value: 'hello' }])
  })

  it('文本 + 完整 CSI 序列切成 text + sequence', () => {
    const t = createTokenizer()
    expect(t.feed('ab\x1b[A')).toEqual([
      { type: 'text', value: 'ab' },
      { type: 'sequence', value: '\x1b[A' },
    ])
  })

  it('PASTE_START / PASTE_END 各自作为独立 sequence 吐出(不聚合)', () => {
    const t = createTokenizer()
    const tokens = t.feed('\x1b[200~hi\x1b[201~')
    expect(tokens).toEqual([
      { type: 'sequence', value: '\x1b[200~' },
      { type: 'text', value: 'hi' },
      { type: 'sequence', value: '\x1b[201~' },
    ])
  })
})

describe('跨 chunk 半截序列缓冲', () => {
  it('CSI 被切成两块,第二块补齐后才吐出完整序列', () => {
    const t = createTokenizer()
    expect(t.feed('x\x1b[')).toEqual([{ type: 'text', value: 'x' }])
    expect(t.buffer()).toBe('\x1b[')
    expect(t.feed('A')).toEqual([{ type: 'sequence', value: '\x1b[A' }])
    expect(t.buffer()).toBe('')
  })

  it('flush 把未完成序列强制吐出', () => {
    const t = createTokenizer()
    t.feed('\x1b[')
    expect(t.flush()).toEqual([{ type: 'sequence', value: '\x1b[' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/termio/tokenize.test.ts`
Expected: FAIL,找不到 `./tokenize.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/termio/tokenize.ts`:

```ts
/**
 * 输入 tokenizer —— 转义序列边界检测。
 *
 * 把终端输入切成 token:文本块与原始转义序列。它只识别边界,不做语义解释。
 * 自 cc-haha 裁剪移植:去掉了 x10Mouse 选项与 X10 鼠标分支(本期不处理鼠标)。
 *
 * 跨 chunk:node 的 stdin 会在任意位置切碎序列,未完成的序列由 buffer() 缓冲,
 * 下次 feed 时拼接;进程退出前 flush() 一次,避免吞字符。
 */

import { C0, ESC_TYPE, isEscFinal } from './ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from './csi.js'

export type Token =
  | { type: 'text'; value: string }
  | { type: 'sequence'; value: string }

type State =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'

export type Tokenizer = {
  /** 喂入输入,返回切出的 token。 */
  feed(input: string): Token[]
  /** 强制吐出缓冲中未完成的序列。 */
  flush(): Token[]
  /** 重置状态。 */
  reset(): void
  /** 取当前缓冲的未完成序列。 */
  buffer(): string
}

/**
 * 创建一个流式 tokenizer。
 *
 * 用法:
 * ```ts
 * const t = createTokenizer()
 * const a = t.feed('hello\x1b[')  // 序列未完成,被缓冲
 * const b = t.feed('A')           // 补齐 → 吐出 \x1b[A
 * const c = t.flush()             // 进程退出前强制吐出残留
 * ```
 */
export function createTokenizer(): Tokenizer {
  let currentState: State = 'ground'
  let currentBuffer = ''

  return {
    feed(input: string): Token[] {
      const result = tokenize(input, currentState, currentBuffer, false)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    flush(): Token[] {
      const result = tokenize('', currentState, currentBuffer, true)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    reset(): void {
      currentState = 'ground'
      currentBuffer = ''
    },

    buffer(): string {
      return currentBuffer
    },
  }
}

type InternalState = {
  state: State
  buffer: string
}

function tokenize(
  input: string,
  initialState: State,
  initialBuffer: string,
  flush: boolean,
): { tokens: Token[]; state: InternalState } {
  const tokens: Token[] = []
  const result: InternalState = {
    state: initialState,
    buffer: '',
  }

  const data = initialBuffer + input
  let i = 0
  let textStart = 0
  let seqStart = 0

  const flushText = (): void => {
    if (i > textStart) {
      const text = data.slice(textStart, i)
      if (text) {
        tokens.push({ type: 'text', value: text })
      }
    }
    textStart = i
  }

  const emitSequence = (seq: string): void => {
    if (seq) {
      tokens.push({ type: 'sequence', value: seq })
    }
    result.state = 'ground'
    textStart = i
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)

    switch (result.state) {
      case 'ground':
        if (code === C0.ESC) {
          flushText()
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          i++
        }
        break

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          result.state = 'csi'
          i++
        } else if (code === ESC_TYPE.OSC) {
          result.state = 'osc'
          i++
        } else if (code === ESC_TYPE.DCS) {
          result.state = 'dcs'
          i++
        } else if (code === ESC_TYPE.APC) {
          result.state = 'apc'
          i++
        } else if (code === 0x4f) {
          // 'O' - SS3
          result.state = 'ss3'
          i++
        } else if (isCSIIntermediate(code)) {
          // 中间字节(如 ESC ( 选字符集)——继续缓冲
          result.state = 'escapeIntermediate'
          i++
        } else if (isEscFinal(code)) {
          // 两字符转义序列
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (code === C0.ESC) {
          // 连续两个 ESC——先吐出前一个,再开新序列
          emitSequence(data.slice(seqStart, i))
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          // 非法——把 ESC 当文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'escapeIntermediate':
        // 中间字节之后,等待终止字节
        if (isCSIIntermediate(code)) {
          i++
        } else if (isEscFinal(code)) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'csi':
        if (isCSIFinal(code)) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++
        } else {
          // 非法 CSI——放弃,当文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'ss3':
        // SS3 序列:ESC O 后跟单个终止字节
        if (code >= 0x40 && code <= 0x7e) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'osc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break

      case 'dcs':
      case 'apc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break
    }
  }

  // 处理输入末尾
  if (result.state === 'ground') {
    flushText()
  } else if (flush) {
    // 强制吐出未完成序列
    const remaining = data.slice(seqStart)
    if (remaining) tokens.push({ type: 'sequence', value: remaining })
    result.state = 'ground'
  } else {
    // 缓冲未完成序列,留待下次
    result.buffer = data.slice(seqStart)
  }

  return { tokens, state: result }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/termio/tokenize.test.ts`
Expected: PASS(切分、跨 chunk、flush 全绿)。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/termio/tokenize.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 4: 移植裁剪 parseKeypress.ts(序列 → ParsedKey + 粘贴聚合)

**Files:**
- Create: `packages/tui/src/input/parseKeypress.ts`
- Test: `packages/tui/src/input/parseKeypress.test.ts`

> 裁剪要点:去掉鼠标(SGR/X10:`SGR_MOUSE_RE`、`parseMouseEvent`、parseKeypress 内两段鼠标分支)与终端响应回包(`DECRPM_RE`/`DA1_RE`/`DA2_RE`/`KITTY_FLAGS_RE`/`CURSOR_POSITION_RE`/`OSC_RESPONSE_RE`/`XTVERSION_RE`、`parseTerminalResponse`、`splitNumericParams`、`TerminalResponse`/`ParsedResponse`/`ParsedMouse`/`DECRPM_STATUS`、`nonAlphanumericKeys`)。`parseMultipleKeypresses` 现在只产 `ParsedKey[]`,只做粘贴聚合 + `parseKeypress`。`createTokenizer()` 不再传 `x10Mouse`。
> **保留:** `CSI_U_RE`、`MODIFY_OTHER_KEYS_RE`(Shift+Enter 的两条解析路径)、`keyName` 导航键表、`isShiftKey`/`isCtrlKey`/`decodeModifier`/`keycodeToName`、`createNavKey`、末尾导航键 switch。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/parseKeypress.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseKeypress,
  parseMultipleKeypresses,
  INITIAL_STATE,
} from './parseKeypress.js'

describe('parseKeypress 基础键', () => {
  it('回车 \\r → name=return', () => {
    const k = parseKeypress('\r')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(false)
  })

  it('裸 LF \\n → name=enter', () => {
    expect(parseKeypress('\n').name).toBe('enter')
  })

  it('退格 \\x7f → name=backspace', () => {
    expect(parseKeypress('\x7f').name).toBe('backspace')
  })

  it('方向上 \\x1b[A → name=up', () => {
    expect(parseKeypress('\x1b[A').name).toBe('up')
  })

  it('Ctrl+C \\x03 → name=c, ctrl=true', () => {
    const k = parseKeypress('\x03')
    expect(k.name).toBe('c')
    expect(k.ctrl).toBe(true)
  })

  it('小写字母透传,大写带 shift', () => {
    expect(parseKeypress('h').name).toBe('h')
    const up = parseKeypress('H')
    expect(up.name).toBe('h')
    expect(up.shift).toBe(true)
  })
})

describe('Shift+Enter 两条协议路径', () => {
  it('Kitty CSI u:ESC[13;2u → return + shift', () => {
    const k = parseKeypress('\x1b[13;2u')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(true)
    expect(k.ctrl).toBe(false)
  })

  it('CSI u 无修饰:ESC[27u → escape', () => {
    expect(parseKeypress('\x1b[27u').name).toBe('escape')
  })

  it('modifyOtherKeys:ESC[27;2;13~ → return + shift', () => {
    const k = parseKeypress('\x1b[27;2;13~')
    expect(k.name).toBe('return')
    expect(k.shift).toBe(true)
  })
})

describe('parseMultipleKeypresses 粘贴聚合', () => {
  it('单块粘贴:PASTE_START..PASTE_END 聚合为一个 isPasted key', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~hello\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('hello')
  })

  it('跨 chunk 粘贴:内容被切成两块,补齐后才吐出', () => {
    let [keys, st] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~hel')
    expect(keys).toEqual([])
    ;[keys, st] = parseMultipleKeypresses(st, 'lo\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('hello')
  })

  it('粘贴内容含换行:多行原样保留', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~a\nb\nc\x1b[201~')
    expect(keys[0]!.sequence).toBe('a\nb\nc')
  })

  it('空粘贴也产出一个 isPasted key(供将来图片侦测)', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~\x1b[201~')
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('')
  })

  it('普通逐字输入产出对应按键', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'hi')
    expect(keys.map((k) => k.name)).toEqual(['hi'.length === 2 ? 'hi' : ''].filter(Boolean))
  })
})
```

> 注:最后一条「普通逐字输入」里,`'hi'` 作为一个 text token 整体进 `parseKeypress('hi')`——`s.length===2` 不命中单字符分支,`name` 保持初始 `''`。改写该用例为下面的明确断言:

```ts
  it('两字符文本块整体作为一个 key(name 为空,序列保留)', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'hi')
    expect(keys.length).toBe(1)
    expect(keys[0]!.sequence).toBe('hi')
    expect(keys[0]!.isPasted).toBe(false)
  })
```

(把上面 describe 块里那条 `'普通逐字输入产出对应按键'` 删掉,换成这条。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/parseKeypress.test.ts`
Expected: FAIL,找不到 `./parseKeypress.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/parseKeypress.ts`:

```ts
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

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/

// eslint-disable-next-line no-control-regex
const FN_KEY_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

// CSI u(kitty keyboard 协议):ESC [ 码位 [; 修饰] u
// 例:ESC[13;2u = Shift+Enter,ESC[27u = Escape(无修饰)。
// 修饰缺省为 1(无修饰)。
// eslint-disable-next-line no-control-regex
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/

// xterm modifyOtherKeys:ESC [ 27 ; 修饰 ; 码位 ~
// 例:ESC[27;2;13~ = Shift+Enter。Ghostty/tmux/xterm/VSCode 在 modifyOtherKeys=2
// 时发这种。注意参数顺序与 CSI u 相反(先修饰、后码位)。
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/

function createPasteKey(content: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
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
      ;(input[0] as unknown as number) -= 128
      return '\x1b' + String(input)
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/parseKeypress.test.ts`
Expected: PASS(基础键、Shift+Enter 两路径、粘贴聚合全绿)。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/parseKeypress.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 5: 新写 parsedKeyToInkKey(ParsedKey → InkKey + input)

**Files:**
- Create: `packages/tui/src/input/parsedKeyToInkKey.ts`
- Test: `packages/tui/src/input/parsedKeyToInkKey.test.ts`

> 把内部 `ParsedKey` 映射为各调用点已使用的 Ink 风格 `key` 形状 + `input` 字符串。这是「shim 零行为改动」的关键:映射后的 `(input, key)` 喂给现有 `keyToEvent` 与各组件的 `key.xxx` 判断仍成立。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/parsedKeyToInkKey.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsedKeyToInkKey } from './parsedKeyToInkKey.js'
import { parseKeypress } from './parseKeypress.js'

describe('parsedKeyToInkKey', () => {
  it('回车:key.return=true,input 为空', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\r'))
    expect(key.return).toBe(true)
    expect(key.shift).toBe(false)
    expect(input).toBe('')
  })

  it('Shift+Enter(CSI u):return + shift', () => {
    const { key } = parsedKeyToInkKey(parseKeypress('\x1b[13;2u'))
    expect(key.return).toBe(true)
    expect(key.shift).toBe(true)
  })

  it('裸 LF:映射为 input=\\n(走换行兜底)', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\n'))
    expect(input).toBe('\n')
    expect(key.return).toBe(false)
  })

  it('方向上:key.upArrow=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b[A')).key.upArrow).toBe(true)
  })

  it('退格:key.backspace=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x7f')).key.backspace).toBe(true)
  })

  it('Tab:key.tab=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\t')).key.tab).toBe(true)
  })

  it('Escape:key.escape=true', () => {
    expect(parsedKeyToInkKey(parseKeypress('\x1b')).key.escape).toBe(true)
  })

  it('Ctrl+C:input=c 且 ctrl=true', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\x03'))
    expect(input).toBe('c')
    expect(key.ctrl).toBe(true)
  })

  it('Ctrl+A:input=a 且 ctrl=true(供 keyToEvent 映射行首)', () => {
    const { input, key } = parsedKeyToInkKey(parseKeypress('\x01'))
    expect(input).toBe('a')
    expect(key.ctrl).toBe(true)
  })

  it('空格:input=单空格', () => {
    expect(parsedKeyToInkKey(parseKeypress(' ')).input).toBe(' ')
  })

  it('可打印字母:input 为该字符(大写保留)', () => {
    expect(parsedKeyToInkKey(parseKeypress('h')).input).toBe('h')
    expect(parsedKeyToInkKey(parseKeypress('H')).input).toBe('H')
  })

  it('VSCode 旧兜底 ESC+CR:映射为换行 input=\\n', () => {
    // 构造一个 sequence 为 \x1b\r 的 ParsedKey(parseKeypress 对它 name 留空)
    const { input } = parsedKeyToInkKey(parseKeypress('\x1b\r'))
    expect(input).toBe('\n')
  })

  it('粘贴 key:整段内容作为 input 文本(本期纯文本插入)', () => {
    const pasted = {
      kind: 'key' as const,
      name: '',
      fn: false,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      sequence: 'line1\nline2',
      raw: 'line1\nline2',
      isPasted: true,
    }
    expect(parsedKeyToInkKey(pasted).input).toBe('line1\nline2')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/parsedKeyToInkKey.test.ts`
Expected: FAIL,找不到 `./parsedKeyToInkKey.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/parsedKeyToInkKey.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/parsedKeyToInkKey.test.ts`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/parsedKeyToInkKey.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 6: 新写 inputBus(订阅 / 广播 / isActive 门控)

**Files:**
- Create: `packages/tui/src/input/inputBus.ts`
- Test: `packages/tui/src/input/inputBus.test.ts`

> 把「订阅者集合 + 派发」抽成框架无关的纯模块,便于单测(对齐 zuse「纯模块单测 + 组件薄分发」风格)。`InputProvider` 只是它的薄 React 包装。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/inputBus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createInputBus } from './inputBus.js'
import { parseKeypress } from './parseKeypress.js'

describe('createInputBus', () => {
  it('广播给 isActive 的订阅者,跳过非 active', () => {
    const bus = createInputBus()
    const got: string[] = []
    const activeRef = { current: { handler: (input: string) => got.push('A:' + input), isActive: true } }
    const offRef = { current: { handler: (input: string) => got.push('B:' + input), isActive: false } }
    bus.subscribe(activeRef)
    bus.subscribe(offRef)

    bus.dispatch(parseKeypress('h'))
    expect(got).toEqual(['A:h'])
  })

  it('传递映射后的 key:方向键置 upArrow', () => {
    const bus = createInputBus()
    let seen: { input: string; up: boolean } | null = null
    bus.subscribe({
      current: {
        handler: (input, key) => {
          seen = { input, up: key.upArrow }
        },
        isActive: true,
      },
    })
    bus.dispatch(parseKeypress('\x1b[A'))
    expect(seen).toEqual({ input: '', up: true })
  })

  it('unsubscribe 后不再收到', () => {
    const bus = createInputBus()
    let count = 0
    const ref = { current: { handler: () => { count++ }, isActive: true } }
    const off = bus.subscribe(ref)
    bus.dispatch(parseKeypress('a'))
    off()
    bus.dispatch(parseKeypress('b'))
    expect(count).toBe(1)
  })

  it('遍历期间退订不抛错(handler 内可能改变订阅集)', () => {
    const bus = createInputBus()
    let off2 = (): void => {}
    const ref1 = { current: { handler: () => off2(), isActive: true } }
    const ref2 = { current: { handler: () => {}, isActive: true } }
    bus.subscribe(ref1)
    off2 = bus.subscribe(ref2)
    expect(() => bus.dispatch(parseKeypress('a'))).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/inputBus.test.ts`
Expected: FAIL,找不到 `./inputBus.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/inputBus.ts`:

```ts
import type { ParsedKey } from './parseKeypress.js'
import { parsedKeyToInkKey, type InkKey } from './parsedKeyToInkKey.js'

export type KeyHandler = (input: string, key: InkKey) => void

/** 一个订阅项的当前状态。用 ref 包裹便于在不重订阅的前提下更新。 */
export interface KeySubscriber {
  handler: KeyHandler
  isActive: boolean
}

export interface InputBus {
  /** 注册订阅项(传 ref);返回退订函数。 */
  subscribe(ref: { current: KeySubscriber }): () => void
  /** 派发一个解析后的按键:映射成 InkKey,广播给所有 isActive 的订阅者。 */
  dispatch(parsed: ParsedKey): void
}

export function createInputBus(): InputBus {
  const subs = new Set<{ current: KeySubscriber }>()
  return {
    subscribe(ref): () => void {
      subs.add(ref)
      return () => {
        subs.delete(ref)
      }
    },
    dispatch(parsed): void {
      const { input, key } = parsedKeyToInkKey(parsed)
      // 先快照成数组再遍历:handler 内可能 subscribe/unsubscribe(如打开对话框),
      // 避免遍历时修改 Set。
      for (const ref of [...subs]) {
        if (ref.current.isActive) ref.current.handler(input, key)
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/inputBus.test.ts`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/inputBus.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 7: 新写 protocol.ts(进出时开关终端协议)

**Files:**
- Create: `packages/tui/src/input/protocol.ts`
- Test: `packages/tui/src/input/protocol.test.ts`

> 进入输入模式时:开 bracketed paste(`?2004h`)、推 Kitty keyboard、开 modifyOtherKeys。退出时**逆序**还原。用注入的 `write` 函数,便于断言写出的序列。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/protocol.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/protocol.test.ts`
Expected: FAIL,找不到 `./protocol.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/protocol.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/protocol.test.ts`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/protocol.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 8: 新写 stdin.ts(接管 process.stdin 与 raw mode 生命周期)

**Files:**
- Create: `packages/tui/src/input/stdin.ts`
- Test: `packages/tui/src/input/stdin.test.ts`

> 用最小的 `StdinLike`/`StdoutLike` 接口而非直接绑 `process.stdin`,使其可注入假流单测。`start` 时:非 TTY 降级不接管;否则设 raw mode、`setEncoding('utf8')`(Windows 关键)、`resume`、推协议、挂 `data` 监听、注册退出/信号清理。`stop` 时:flush 残留序列、卸监听、还原协议、关 raw mode、摘清理钩子。

- [ ] **Step 1: 写失败测试**

`packages/tui/src/input/stdin.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createStdinManager } from './stdin.js'
import type { ParsedKey } from './parseKeypress.js'
import {
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from './protocol.js'

function makeFakeStdin(isTTY: boolean) {
  const listeners: Record<string, ((chunk: string) => void)[]> = {}
  return {
    isTTY,
    raw: null as boolean | null,
    encoding: '',
    resumed: false,
    setRawMode(m: boolean) {
      this.raw = m
    },
    setEncoding(e: string) {
      this.encoding = e
    },
    resume() {
      this.resumed = true
    },
    pause() {},
    on(ev: string, fn: (chunk: string) => void) {
      ;(listeners[ev] ??= []).push(fn)
    },
    off(ev: string, fn: (chunk: string) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)
    },
    emit(ev: string, chunk: string) {
      ;(listeners[ev] ?? []).forEach((f) => f(chunk))
    },
    listenerCount(ev: string) {
      return (listeners[ev] ?? []).length
    },
  }
}

function makeFakeBus(collected: ParsedKey[]) {
  return {
    subscribe: () => () => {},
    dispatch: (k: ParsedKey) => {
      collected.push(k)
    },
  }
}

describe('createStdinManager', () => {
  it('TTY:start 设 raw、utf8、resume,并推开启协议', () => {
    const stdin = makeFakeStdin(true)
    const out: string[] = []
    const stdout = { write: (s: string) => out.push(s) }
    const mgr = createStdinManager({ stdin: stdin as never, stdout, bus: makeFakeBus([]) })
    mgr.start()
    expect(stdin.raw).toBe(true)
    expect(stdin.encoding).toBe('utf8')
    expect(stdin.resumed).toBe(true)
    expect(out[0]).toBe(ENABLE_BRACKETED_PASTE)
    expect(stdin.listenerCount('data')).toBe(1)
  })

  it('data chunk 经解析后派发到 bus', () => {
    const stdin = makeFakeStdin(true)
    const keys: ParsedKey[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: () => {} },
      bus: makeFakeBus(keys),
    })
    mgr.start()
    stdin.emit('data', 'a\r')
    expect(keys.map((k) => k.name)).toEqual(['a', 'return'])
  })

  it('stop:卸监听、还原协议、关 raw', () => {
    const stdin = makeFakeStdin(true)
    const out: string[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: (s: string) => out.push(s) },
      bus: makeFakeBus([]),
    })
    mgr.start()
    out.length = 0
    mgr.stop()
    expect(stdin.listenerCount('data')).toBe(0)
    expect(stdin.raw).toBe(false)
    expect(out[out.length - 1]).toBe(DISABLE_BRACKETED_PASTE)
  })

  it('非 TTY:降级,不设 raw、不挂监听、不推协议', () => {
    const stdin = makeFakeStdin(false)
    const out: string[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: (s: string) => out.push(s) },
      bus: makeFakeBus([]),
    })
    mgr.start()
    expect(stdin.raw).toBe(null)
    expect(stdin.listenerCount('data')).toBe(0)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/input/stdin.test.ts`
Expected: FAIL,找不到 `./stdin.js`。

- [ ] **Step 3: 写实现**

`packages/tui/src/input/stdin.ts`:

```ts
import {
  parseMultipleKeypresses,
  INITIAL_STATE,
  type KeyParseState,
} from './parseKeypress.js'
import { enterInputMode, leaveInputMode } from './protocol.js'
import type { InputBus } from './inputBus.js'

/** process.stdin 所需能力的最小子集(便于注入假流单测)。 */
export interface StdinLike {
  isTTY?: boolean
  setRawMode?(mode: boolean): void
  setEncoding?(encoding: string): void
  resume(): void
  pause(): void
  on(event: 'data', listener: (chunk: Buffer | string) => void): void
  off(event: 'data', listener: (chunk: Buffer | string) => void): void
}

export interface StdoutLike {
  write(data: string): void
}

export interface StdinManagerOptions {
  stdin: StdinLike
  stdout: StdoutLike
  bus: InputBus
}

export interface StdinManager {
  start(): void
  stop(): void
}

/**
 * 接管 stdin:解析按键并派发到 bus,管理 raw mode 与协议的进出。
 * 非 TTY 或不支持 raw mode 时降级——不接管、不推协议(见 spec §9)。
 */
export function createStdinManager(opts: StdinManagerOptions): StdinManager {
  const { stdin, stdout, bus } = opts
  let state: KeyParseState = INITIAL_STATE
  let started = false

  const canRaw = (): boolean =>
    !!stdin.isTTY && typeof stdin.setRawMode === 'function'

  const onData = (chunk: Buffer | string): void => {
    const [keys, next] = parseMultipleKeypresses(state, chunk)
    state = next
    for (const k of keys) bus.dispatch(k)
  }

  const cleanup = (): void => {
    manager.stop()
  }

  const manager: StdinManager = {
    start(): void {
      if (started) return
      started = true
      // 非 TTY / 不支持 raw mode:降级,保持与现状一致(主要面向交互式 TTY)。
      if (!canRaw()) return
      stdin.setRawMode!(true)
      stdin.setEncoding?.('utf8')
      stdin.resume()
      enterInputMode((s) => stdout.write(s))
      stdin.on('data', onData)
      // 异常/退出/信号都要还原终端,避免留在坏状态。
      process.once('exit', cleanup)
      process.once('SIGINT', cleanup)
      process.once('SIGTERM', cleanup)
    },

    stop(): void {
      if (!started) return
      started = false
      // flush 半截序列,避免吞字符。
      const [keys] = parseMultipleKeypresses(state, null)
      for (const k of keys) bus.dispatch(k)
      state = INITIAL_STATE
      stdin.off('data', onData)
      if (canRaw()) {
        leaveInputMode((s) => stdout.write(s))
        stdin.setRawMode!(false)
      }
      process.removeListener('exit', cleanup)
      process.removeListener('SIGINT', cleanup)
      process.removeListener('SIGTERM', cleanup)
    },
  }

  return manager
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/input/stdin.test.ts`
Expected: PASS。

> 若测试因进程信号监听器告警(MaxListeners)而吵闹,属正常——start/stop 成对摘钩,单测里不会泄漏。

- [ ] **Step 5: 检查点**

Run: `npx vitest run packages/tui/src/input/stdin.test.ts && pnpm -F @zuse/tui typecheck`
Expected: 通过、无类型错误。

---

## Task 9: 新写 InputProvider.tsx + useInput.ts(React 薄包装)

**Files:**
- Create: `packages/tui/src/input/InputProvider.tsx`
- Create: `packages/tui/src/input/useInput.ts`

> 无独立单测(React Context + 真实 stdin 接管不适合在 vitest node 环境跑;核心逻辑已在 inputBus/stdin 单测覆盖)。正确性由 Task 12 的端到端冒烟验证。

- [ ] **Step 1: 写 InputProvider.tsx**

`packages/tui/src/input/InputProvider.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { createInputBus, type InputBus } from './inputBus.js'
import { createStdinManager } from './stdin.js'

const InputBusContext = createContext<InputBus | null>(null)

/** 取当前 InputBus;必须在 <InputProvider> 内调用。 */
export function useInputBus(): InputBus {
  const bus = useContext(InputBusContext)
  if (!bus) throw new Error('useInputBus 必须在 <InputProvider> 内使用')
  return bus
}

interface InputProviderProps {
  children: ReactNode
}

/**
 * 输入子系统的根 Provider:挂载时接管真实 process.stdin,卸载时还原。
 * Ink 已被入口喂哑 stdin,故这里独占真实键盘输入,不与 Ink 抢。
 */
export function InputProvider({ children }: InputProviderProps): ReactNode {
  const bus = useMemo(() => createInputBus(), [])
  useEffect(() => {
    const mgr = createStdinManager({
      stdin: processStdin,
      stdout: processStdout,
      bus,
    })
    mgr.start()
    return () => mgr.stop()
  }, [bus])
  return (
    <InputBusContext.Provider value={bus}>{children}</InputBusContext.Provider>
  )
}
```

- [ ] **Step 2: 写 useInput.ts**

`packages/tui/src/input/useInput.ts`:

```ts
import { useEffect, useRef } from 'react'
import { useInputBus } from './InputProvider.js'
import type { InkKey } from './parsedKeyToInkKey.js'
import type { KeySubscriber } from './inputBus.js'

export type { InkKey }

/**
 * 与 Ink `useInput((input, key) => void, { isActive })` 同签名的 shim。
 * isActive=false 时不收键;多个 useInput 并存时各自门控(对齐现有
 * SelectList/ModelSelect 的互斥逻辑)。
 *
 * 用 ref 持有最新 handler/isActive:订阅项在挂载时注册一次、卸载时退订,
 * 期间靠 ref 拿到每次渲染的最新闭包,无需因 handler 变化而反复重订阅。
 */
export function useInput(
  handler: (input: string, key: InkKey) => void,
  opts?: { isActive?: boolean },
): void {
  const bus = useInputBus()
  const isActive = opts?.isActive ?? true
  const ref = useRef<KeySubscriber>({ handler, isActive })
  ref.current.handler = handler
  ref.current.isActive = isActive
  useEffect(() => {
    return bus.subscribe(ref)
  }, [bus])
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无类型错误(此时尚未有人 import 它们,只验证自身类型成立)。

- [ ] **Step 4: 检查点**

Run: `npx vitest run packages/tui/src/input && pnpm -F @zuse/tui typecheck`
Expected: input 目录下全部测试通过、无类型错误。

---

## Task 10: 入口接线(Ink 喂哑 stdin + 外层包 InputProvider)

**Files:**
- Modify: `packages/tui/src/index.tsx`

> 给 Ink 喂一个非 TTY 哑流,使 Ink 永不碰键盘;真实 stdin 由 `InputProvider`(Task 9)独占。注意:本 Task 之后、Task 11 之前,App 树里仍残留从 `'ink'` 导入的 useInput——它们会订阅哑流而永不触发。因此 **Task 10 与 11 必须连续完成**,中间不交付。

- [ ] **Step 1: 改 index.tsx**

把 [packages/tui/src/index.tsx](../../packages/tui/src/index.tsx) 顶部 import 与最后的 `render` 调用改为:

```tsx
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { cwd as processCwd, env, stderr } from 'node:process'
import { loadSettings, installProxy } from '@zuse/core'
import { App } from './App.js'
import { InputProvider } from './input/InputProvider.js'
```

(其余 cwd / proxy 逻辑不变。)最后一行 `render(...)` 改为:

```tsx
// 给 Ink 喂一个非 TTY 哑流:Ink 的 useInput/焦点管理永不触发、不碰键盘,
// 真实 process.stdin 全权交给 InputProvider 接管(见 input/ 子系统)。
// Ink 仍正常渲染到 stdout,resize 走 stdout 不受影响。
const dummyStdin = new PassThrough() as unknown as NodeJS.ReadStream
dummyStdin.isTTY = false

// exitOnCtrlC:false 关掉 Ink 默认的「单击 Ctrl+C 立即退出」,改由 App 实现双击退出。
render(
  <InputProvider>
    <App cwd={cwd} />
  </InputProvider>,
  { stdin: dummyStdin, exitOnCtrlC: false },
)
```

- [ ] **Step 2: typecheck**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无类型错误。

> 不在此单独跑 app;继续 Task 11(迁移调用点)后再整体冒烟。

---

## Task 11: 迁移 4 个 useInput 调用点 + Shift+Enter 映射

**Files:**
- Modify: `packages/tui/src/components/inputKeymap.ts`
- Modify: `packages/tui/src/App.tsx:2`
- Modify: `packages/tui/src/components/InputBox.tsx:1`
- Modify: `packages/tui/src/components/ModelSelect.tsx:1`
- Modify: `packages/tui/src/components/SelectList.tsx:1`

### 11a:inputKeymap 支持 Shift+Enter

- [ ] **Step 1: 写失败测试**

把以下用例追加进 `packages/tui/src/components/inputKeymap.test.ts`(若该文件不存在则新建,并在顶部加 `import { describe, it, expect } from 'vitest'` 与 `import { keyToEvent } from './inputKeymap.js'`):

```ts
describe('Shift+Enter 换行', () => {
  it('return + shift → newline', () => {
    expect(keyToEvent('', { return: true, shift: true })).toEqual({ type: 'newline' })
  })
  it('return 无 shift → submit', () => {
    expect(keyToEvent('', { return: true })).toEqual({ type: 'submit' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/components/inputKeymap.test.ts -t "Shift+Enter"`
Expected: FAIL(当前 `return:true` 一律 submit,shift 分支不存在)。

- [ ] **Step 3: 改 inputKeymap.ts**

在 [packages/tui/src/components/inputKeymap.ts](../../packages/tui/src/components/inputKeymap.ts) 的 `KeyState` 接口里增加 `shift`:

```ts
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
  shift?: boolean
}
```

在 `keyToEvent` 函数体最前面(`if (key.return) return { type: 'submit' }` 之前)插入 Shift+Enter 分支,并补注释:

```ts
export function keyToEvent(input: string, key: KeyState): InputEvent {
  // Shift+Enter:现代终端经 Kitty keyboard / modifyOtherKeys 协议原生上报
  // (parseKeypress 解出 return+shift)→ 换行。须在普通回车提交分支之前判定。
  if (key.return && key.shift) return { type: 'newline' }
  // 普通回车(key.return):提交。Ctrl/Alt 等修饰在回车上一律忽略。
  if (key.return) return { type: 'submit' }
  // ……(以下保留不变)
```

(其余分支——`input==='\r'`、`input==='\n'`、退格、方向、Ctrl+A/E、escape、插入——**全部保留不变**,它们仍是不支持协议的终端的兜底路径。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/components/inputKeymap.test.ts`
Expected: PASS(新增 Shift+Enter 用例 + 原有用例全绿)。

### 11b:4 个调用点换 import

- [ ] **Step 5: 改 App.tsx**

[packages/tui/src/App.tsx:2](../../packages/tui/src/App.tsx#L2) 把 `useInput` 从 ink 的 import 里移除,新增一行从 shim 导入:

```tsx
import { Box, Text, Static, useApp } from 'ink'
```

并在该 import 之后加:

```tsx
import { useInput } from './input/useInput.js'
```

(App 内 `useInput((input, key) => { ... })` 调用体不动。)

- [ ] **Step 6: 改 InputBox.tsx**

[packages/tui/src/components/InputBox.tsx:1](../../packages/tui/src/components/InputBox.tsx#L1):

```tsx
import { Box, Text } from 'ink'
```

并在其后加:

```tsx
import { useInput } from '../input/useInput.js'
```

(组件内两处 `useInput` 调用体不动。)

- [ ] **Step 7: 改 ModelSelect.tsx**

[packages/tui/src/components/ModelSelect.tsx:1](../../packages/tui/src/components/ModelSelect.tsx#L1):

```tsx
import { Box, Text } from 'ink'
import { useInput } from '../input/useInput.js'
```

- [ ] **Step 8: 改 SelectList.tsx**

[packages/tui/src/components/SelectList.tsx:1](../../packages/tui/src/components/SelectList.tsx#L1):

```tsx
import { Box, Text } from 'ink'
import { useInput } from '../input/useInput.js'
```

- [ ] **Step 9: 确认没有遗留的 Ink useInput / useFocus**

Run: `grep -rn "from 'ink'" packages/tui/src | grep -E "useInput|useFocus"`
Expected: 无输出(空)。若有,补迁移。

- [ ] **Step 10: 检查点(全量测试 + typecheck + build)**

Run: `npx vitest run && pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui build`
Expected: 全部测试通过、无类型错误、构建成功。

---

## Task 12: 端到端冒烟(手动)+ 收尾

**Files:** 无(纯验证)

> 自动化单测覆盖了纯模块;真实终端行为(raw mode、协议、粘贴边界、退出后终端状态)需手动验。

- [ ] **Step 1: 构建并启动**

Run: `pnpm -F @zuse/tui build && pnpm -F @zuse/tui start`
(或 `pnpm dev` 走 tsx。)

- [ ] **Step 2: 逐项手动验收(对照 spec §8 第一期验收)**

在真实终端逐项确认:

- [ ] 普通输入字符正常显示、光标正常移动(左右上下、Ctrl+A/E 行首尾)。
- [ ] **Enter 发送**消息;**Shift+Enter 换行**(现代终端:Windows Terminal / iTerm2 / kitty / Ghostty / VSCode 集成终端)。
- [ ] **Ctrl+J 换行**(任意终端兜底)。
- [ ] 不支持协议的老终端里 Shift+Enter 退化为发送(已知限制,不算回归);`/terminal-setup` 的 ESC+CR 兜底仍换行。
- [ ] **粘贴多行文本**:本期按纯文本整段插入(不折叠),内容完整、不丢字符、不串入控制字符。
- [ ] **退格/删除**删字符;**Esc** 在流式时中断、非流式无副作用。
- [ ] **Ctrl+C 双击退出**;单击只提示。
- [ ] `/` 命令菜单:方向键导航、Tab/Enter 选中、Esc 关闭——行为不回归。
- [ ] 模型选择器(`/model` 等触发):左右切 provider、上下选 model、空格/Enter 确认、Esc 取消、Tab 切焦——行为不回归。
- [ ] **退出后终端状态干净**:`echo $?` 后正常输入、无 raw mode 残留、无粘贴/kitty 模式泄漏(粘贴一段文本应正常,而非出现 `200~`/`201~` 字面)。

- [ ] **Step 3: 跨平台抽查(条件允许时)**

至少在 Windows(Windows Terminal 或 VSCode 集成终端)验一遍;有条件再验 macOS / Linux。重点:粘贴不丢字、Shift+Enter、退出后终端干净。

- [ ] **Step 4: 收尾**

- 全量测试 + 构建复跑一次:`npx vitest run && pnpm -F @zuse/tui build`
- 按项目约定**不提交**,把改动留作评审。向用户汇报:已完成第一期(输入层地基),列出本期未做项(粘贴折叠 UI、附件 → 第二期)。

---

## 附:与 spec 的覆盖对照(自检)

- spec §8 第一期 1(移植 termio + parseKeypress)→ Task 1-4 ✅
- spec §8 第一期 2(protocol / stdin / InputProvider / useInput)→ Task 6-9 ✅(inputBus 为 InputProvider 的可测内核)
- spec §8 第一期 3(入口喂哑 stdin + 包 InputProvider)→ Task 10 ✅
- spec §8 第一期 4(迁移 4 个调用点)→ Task 11b ✅
- spec §8 第一期 5(根治 Shift+Enter:协议推送 + 映射 + 兜底)→ protocol(Task 7)+ parseKeypress CSI-u/modifyOtherKeys(Task 4)+ parsedKeyToInkKey(Task 5)+ inputKeymap(Task 11a)✅
- spec §8 第一期 6(粘贴本期纯文本插入,检测换为可靠 isPasted 但不折叠)→ parseKeypress 聚合产 isPasted(Task 4)+ parsedKeyToInkKey 把 paste 内容当 input 文本(Task 5)✅
- spec §9 错误处理(raw mode 生命周期、非 TTY 降级、协议无害、半截序列 flush、跨平台 utf8)→ Task 8 stdin + Task 12 冒烟 ✅
- spec §10 测试策略(tokenize / parseKeypress / useInput 门控)→ Task 3 / 4 / 6 ✅

**第二期专属(本计划不做):** 粘贴折叠 UI、占位符 token、textBuffer 原子编辑、message 双份文本、usePaste 钩子。

