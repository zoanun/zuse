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
          // 两字符转义序列。注:ESC_TYPE.PM(0x5e)/SOS(0x58)落入此分支,被当作
          // 两字符序列吐出——v1 不单独处理 PM/SOS 字符串(与 cc-haha 一致)。
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
