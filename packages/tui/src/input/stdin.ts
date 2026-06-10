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

/** 孤立 ESC 等待续字节的时间窗口(毫秒)。超过则视为单独的 Escape 键。 */
export const ESC_FLUSH_TIMEOUT_MS = 50

/**
 * 接管 stdin:解析按键并派发到 bus,管理 raw mode 与协议的进出。
 * 非 TTY 或不支持 raw mode 时降级——不接管、不推协议(见 spec §9)。
 */
export function createStdinManager(opts: StdinManagerOptions): StdinManager {
  const { stdin, stdout, bus } = opts
  let state: KeyParseState = INITIAL_STATE
  let started = false
  let didActivate = false
  // 孤立 ESC 超时 flush 定时器:真实终端里 ESC 序列字节在同一个 data chunk 或连续
  // 两个 chunk 里到达;若 50ms 内没有后续字节,则视为孤立 ESC 并 flush。
  // 参考 cc-haha App.tsx 的 NORMAL_TIMEOUT 设计。
  let escapeTimer: NodeJS.Timeout | null = null

  const canRaw = (): boolean =>
    !!stdin.isTTY && typeof stdin.setRawMode === 'function'

  const doFlush = (): void => {
    escapeTimer = null
    if (!state.incomplete) return
    const [keys, next] = parseMultipleKeypresses(state, null)
    state = next
    for (const k of keys) bus.dispatch(k)
  }

  const onData = (chunk: Buffer | string): void => {
    // 取消上一次的孤立 ESC 定时器(新数据可能是之前 ESC 的续字节)。
    if (escapeTimer) {
      clearTimeout(escapeTimer)
      escapeTimer = null
    }
    const [keys, next] = parseMultipleKeypresses(state, chunk)
    state = next
    for (const k of keys) bus.dispatch(k)
    // 若处理后仍有半截序列(最常见:孤立 ESC),等 50ms 看是否还有续字节;
    // 超时则 flush,把孤立 ESC 作为 escape 键派发。
    if (state.incomplete) {
      escapeTimer = setTimeout(doFlush, ESC_FLUSH_TIMEOUT_MS)
    }
  }

  const cleanup = (): void => {
    manager.stop()
  }

  const manager: StdinManager = {
    start(): void {
      if (started) return
      started = true
      // 非 TTY / 不支持 raw mode:降级,didActivate 保持 false,stop 时也不做还原。
      if (!canRaw()) return
      didActivate = true
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
      // 清理孤立 ESC 定时器,避免在卸载后触发。
      if (escapeTimer) {
        clearTimeout(escapeTimer)
        escapeTimer = null
      }
      // 从未真正接管(非 TTY 降级)时无需还原,直接返回——与 start 决策对称。
      if (!didActivate) return
      didActivate = false
      // flush 半截序列,避免吞字符。
      const [keys] = parseMultipleKeypresses(state, null)
      for (const k of keys) bus.dispatch(k)
      state = INITIAL_STATE
      stdin.off('data', onData)
      leaveInputMode((s) => stdout.write(s))
      stdin.setRawMode!(false)
      process.removeListener('exit', cleanup)
      process.removeListener('SIGINT', cleanup)
      process.removeListener('SIGTERM', cleanup)
    },
  }

  return manager
}
